require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const path = require('path');
const fs = require('fs');
const { handleIncoming } = require('./sms');
const { importContacts } = require('./import');
const { getSettings, saveSettings } = require('./settings');
const { getReceiptText } = require('./payments');
const db = require('./db');

const app = express();
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── STRIPE WEBHOOK (must come BEFORE express.json()) ──────────
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`[WEBHOOK] Signature failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const phone = intent.metadata?.phone;
    const amount = intent.amount / 100;
    if (phone) {
      try {
        const s = getSettings();
        const contact = db.getContact(phone);
        const name = contact?.name ? contact.name.split(' ')[0] : null;
        const receiptText = await getReceiptText(amount, name, s.receiptType || 'donation', s.receiptMessage || null);
        await twilioClient.messages.create({ body: receiptText, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
        // Mark RSVP as paid if ticket pending
        const rsvpsFile = path.join(__dirname, 'data', 'rsvps.json');
        if (fs.existsSync(rsvpsFile)) {
          const rsvps = JSON.parse(fs.readFileSync(rsvpsFile, 'utf8'));
          Object.keys(rsvps).forEach(eventId => {
            if (rsvps[eventId][phone]?.paymentStatus === 'pending') {
              rsvps[eventId][phone].paymentStatus = 'paid';
              rsvps[eventId][phone].paidAt = new Date().toISOString();
            }
          });
          fs.writeFileSync(rsvpsFile, JSON.stringify(rsvps, null, 2));
        }
      } catch (smsErr) { console.error(`[WEBHOOK] Receipt SMS failed:`, smsErr.message); }
      if (process.env.ADMIN_PHONE) {
        try {
          const contact = db.getContact(phone);
          await twilioClient.messages.create({ body: `💰 Payment received: $${amount} from ${contact?.name || phone}`, from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ADMIN_PHONE });
        } catch (err) { console.error(`[WEBHOOK] Admin notify failed:`, err.message); }
      }
    }
  }
  res.json({ received: true });
});

// ── STANDARD MIDDLEWARE ───────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => res.json({ status: 'ok', name: 'Chabad Rivertowns SMS System', time: new Date().toISOString() }));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/settings', (req, res) => res.json(getSettings()));
app.post('/settings', (req, res) => {
  try { const updated = saveSettings(req.body); res.json({ success: true, settings: updated }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── INCOMING SMS ──────────────────────────────────────────────
app.post('/sms/incoming', async (req, res) => {
  const from = req.body.From, body = req.body.Body;
  if (!from || !body) return res.status(400).send('Missing From or Body');

  // Handle STOP — mark contact as unsubscribed
  const msgLower = body.trim().toLowerCase();
  if (['stop','unsubscribe','cancel','end','quit'].includes(msgLower)) {
    db.saveContact(from, { unsubscribed: true, unsubscribedAt: new Date().toISOString() });
    db.clearConversation(from);
    console.log(`[STOP] ${from} unsubscribed`);
    // Twilio handles the actual blocking — we just mark the record
    return res.status(200).send('OK');
  }

  // Handle START — re-subscribe
  if (['start','subscribe','yes'].includes(msgLower) ) {
    db.saveContact(from, { unsubscribed: false });
    return res.status(200).send('OK');
  }

  try {
    const reply = await handleIncoming(from, body);
    console.log(`[SMS OUT] → ${from}: "${reply.substring(0,80)}..."`);
    await twilioClient.messages.create({ body: reply, from: process.env.TWILIO_PHONE_NUMBER, to: from });
    // Admin notification on initial RSVP replies
    if (body.trim() === '1' || body.trim() === '2') {
      const contact = db.getContact(from);
      const status = body.trim() === '1' ? '✅ YES' : '❌ No';
      await twilioClient.messages.create({ body: `[RSVP] ${contact?.name || from} replied: ${status}`, from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ADMIN_PHONE }).catch(() => {});
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[INCOMING ERROR]', err.message, err.stack);
    // Always send something back so the user isn't left hanging
    try {
      await twilioClient.messages.create({
        body: `Sorry, something went wrong. Please try again or call (914) 330-1307.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: from
      });
    } catch (sendErr) { console.error('[FALLBACK SMS ERROR]', sendErr.message); }
    res.status(200).send('OK');
  }
});

// ── BLAST ─────────────────────────────────────────────────────
app.post('/blast', async (req, res) => {
  const { event, phones } = req.body;
  if (!event || !phones?.length) return res.status(400).json({ error: 'Missing event or phones' });
  const s = getSettings();
  const eventId = `evt_${Date.now()}`;
  db.saveEvent({ id: eventId, ...event, sentAt: new Date().toISOString(), sentTo: phones.length });

  const baseMsg = `${s.botIntro}\n\nWill you be joining us for ${event.name} ${event.date} @ ${event.time}?`;
  const suffix = (event.customMessage ? `\n\n${event.customMessage}` : '') + `\n\n${s.rsvpPrompt}`;
  let sent = 0, failed = 0;

  for (const phone of phones) {
    try {
      // Skip unsubscribed contacts
      const contact = db.getContact(phone);
      if (contact?.unsubscribed) { console.log(`[BLAST SKIP] ${phone} unsubscribed`); failed++; continue; }

      const firstName = contact?.name ? contact.name.split(' ')[0] : null;
      const msgBody = `${firstName ? 'Hi ' + firstName + '! ' : 'Hi! '}${baseMsg}${suffix}`;
      await twilioClient.messages.create({ body: msgBody, from: process.env.TWILIO_PHONE_NUMBER, to: phone });

      // Save which event was most recently sent to this contact
      db.saveContact(phone, { lastEventId: eventId, lastBlastAt: new Date().toISOString() });

      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) { console.error(`[BLAST ERROR] ${phone}:`, err.message); failed++; }
  }
  res.json({ success: true, eventId, sent, failed });
});

// ── CONTACTS ──────────────────────────────────────────────────
app.get('/contacts', (req, res) => res.json(db.getAllContacts()));
app.post('/contacts', (req, res) => {
  const { phone, name, lists } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  res.json(db.saveContact(phone, { name, lists: lists || ['all'] }));
});
app.patch('/contacts/:phone', (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { lists } = req.body;
  if (!lists) return res.status(400).json({ error: 'lists required' });
  res.json(db.saveContact(phone, { lists }));
});
app.delete('/contacts/:phone', (req, res) => {
  try { db.deleteContact(decodeURIComponent(req.params.phone)); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/contacts/bulk-delete', (req, res) => {
  const { phones } = req.body;
  if (!phones?.length) return res.status(400).json({ error: 'phones required' });
  try { db.bulkDeleteContacts(phones); res.json({ success: true, deleted: phones.length }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/contacts/bulk-remove-from-list', (req, res) => {
  const { phones, listId } = req.body;
  if (!phones?.length || !listId) return res.status(400).json({ error: 'phones and listId required' });
  try { db.removeContactsFromList(phones, listId); res.json({ success: true, removed: phones.length }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/contacts/import', (req, res) => {
  const { csv, mapping, listId, listName } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data' });
  try { res.json(importContacts(csv, mapping || {}, listId, listName)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/contacts/csv-preview', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data' });
  try { const { getCSVPreview } = require('./import'); res.json(getCSVPreview(csv, 3)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── EVENTS ────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  const eventsFile = path.join(__dirname, 'data', 'events.json');
  try {
    const data = fs.existsSync(eventsFile) ? JSON.parse(fs.readFileSync(eventsFile, 'utf8')) : {};
    res.json(Object.values(data).sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)));
  } catch { res.json([]); }
});
app.delete('/api/events/:eventId', (req, res) => {
  try {
    const { eventId } = req.params;
    const eventsFile = path.join(__dirname, 'data', 'events.json');
    const rsvpsFile = path.join(__dirname, 'data', 'rsvps.json');
    if (fs.existsSync(eventsFile)) {
      const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
      if (!events[eventId]) return res.status(404).json({ error: 'Event not found' });
      delete events[eventId];
      fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
    }
    if (fs.existsSync(rsvpsFile)) {
      const rsvps = JSON.parse(fs.readFileSync(rsvpsFile, 'utf8'));
      delete rsvps[eventId];
      fs.writeFileSync(rsvpsFile, JSON.stringify(rsvps, null, 2));
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RSVPs ─────────────────────────────────────────────────────
app.get('/rsvps/latest', (req, res) => {
  const event = db.getLatestEvent();
  if (!event) return res.json({ event: null, rsvps: [] });
  res.json({ event, rsvps: db.getRsvpsForEvent(event.id) });
});
app.get('/rsvps/:eventId', (req, res) => res.json(db.getRsvpsForEvent(req.params.eventId)));

// ── DONORS ────────────────────────────────────────────────────
app.get('/api/donors', async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    const customers = await stripe.customers.search({ query: `metadata['source']:'sms-rsvp'`, limit: 100 });
    const donors = await Promise.all(customers.data.map(async (customer) => {
      let card = null;
      try {
        const methods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1 });
        if (methods.data.length > 0) { const pm = methods.data[0].card; card = { brand: pm.brand, last4: pm.last4, expMonth: pm.exp_month, expYear: pm.exp_year }; }
      } catch (e) {}
      let totalDonated = 0, donationCount = 0, lastDonation = null;
      try {
        const intents = await stripe.paymentIntents.list({ customer: customer.id, limit: 100 });
        const succeeded = intents.data.filter(p => p.status === 'succeeded');
        totalDonated = succeeded.reduce((sum, p) => sum + p.amount, 0) / 100;
        donationCount = succeeded.length;
        if (succeeded.length > 0) lastDonation = new Date(succeeded[0].created * 1000).toLocaleDateString();
      } catch (e) {}
      return { id: customer.id, name: customer.name || '—', phone: customer.metadata?.phone || '—', email: customer.email || '—', card, totalDonated, donationCount, lastDonation, created: new Date(customer.created * 1000).toLocaleDateString() };
    }));
    donors.sort((a, b) => b.totalDonated - a.totalDonated);
    res.json(donors);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PAGES ─────────────────────────────────────────────────────
app.get('/donation-success', (req, res) => {
  const amount = req.query.amount || '';
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thank You!</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;background:#f9f4ec;}.card{background:white;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,0.08);}h1{color:#1565c0;}p{color:#555;line-height:1.6;}.amount{font-size:32px;font-weight:bold;color:#1565c0;margin:16px 0;}</style></head><body><div class="card"><div style="font-size:60px;margin-bottom:16px">❤️</div><h1>Thank You!</h1><div class="amount">${amount?'$'+amount:''}</div><p>Your payment to Chabad of the Rivertowns has been received.</p><p style="margin-top:30px;color:#888;font-size:13px;">— Rabbi Benjy & Hinda Silverman</p></div></body></html>`);
});
app.get('/donation-cancel', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>No Problem</title><style>body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;background:#f9f4ec;}.card{background:white;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;}h1{color:#555;}p{color:#777;}</style></head><body><div class="card"><div style="font-size:50px;margin-bottom:16px">↩️</div><h1>No problem!</h1><p>Payment cancelled. Reply to any of our texts to try again.</p></div></body></html>`);
});

const https = require('https');
setInterval(() => { const url = process.env.APP_URL; if (url) https.get(url).on('error', () => {}); }, 4 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✡️  Chabad SMS System running on port ${PORT}`);
  console.log(`   Twilio: ${process.env.TWILIO_PHONE_NUMBER} | Admin: ${process.env.ADMIN_PHONE}`);
}).on('error', (err) => { console.error('Server error:', err); process.exit(1); });
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
