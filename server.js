require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const path = require('path');
const fs = require('fs');
const { handleIncoming } = require('./sms');
const { importContacts } = require('./import');
const { getSettings, saveSettings } = require('./settings');
const { getDonationConfirmationText } = require('./payments');
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
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const phone = session.metadata?.phone;
    const amount = session.metadata?.amount || (session.amount_total / 100);
    console.log(`[WEBHOOK] Payment complete — phone: ${phone}, amount: $${amount}`);
    if (phone) {
      try {
        const contact = db.getContact(phone);
        const name = contact?.name ? contact.name.split(' ')[0] : null;
        const confirmText = await getDonationConfirmationText(amount, name);
        await twilioClient.messages.create({ body: confirmText, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
        console.log(`[WEBHOOK] Confirmation SMS sent to ${phone}`);
      } catch (smsErr) {
        console.error(`[WEBHOOK] Confirmation SMS failed:`, smsErr.message);
      }
    }
    if (process.env.ADMIN_PHONE) {
      try {
        const contact = db.getContact(phone);
        const name = contact?.name || phone;
        await twilioClient.messages.create({ body: `💰 Donation received: $${amount} from ${name}`, from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ADMIN_PHONE });
      } catch (err) {
        console.error(`[WEBHOOK] Admin notify failed:`, err.message);
      }
    }
  }
  res.json({ received: true });
});

// ── STANDARD MIDDLEWARE (after webhook route) ─────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', name: 'Chabad Rivertowns SMS System', time: new Date().toISOString() }));

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ── SETTINGS API ──────────────────────────────────────────────
app.get('/settings', (req, res) => res.json(getSettings()));
app.post('/settings', (req, res) => {
  try {
    const updated = saveSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INCOMING SMS ──────────────────────────────────────────────
app.post('/sms/incoming', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  if (!from || !body) return res.status(400).send('Missing From or Body');
  try {
    const reply = await handleIncoming(from, body);
    console.log(`[SMS OUT] → ${from}: "${reply}"`);
    await twilioClient.messages.create({ body: reply, from: process.env.TWILIO_PHONE_NUMBER, to: from });
    const msg = body.trim();
    if (msg === '1' || msg === '2') {
      const contact = db.getContact(from);
      const name = contact?.name || from;
      const status = msg === '1' ? '✅ YES' : '❌ No';
      await twilioClient.messages.create({ body: `[RSVP] ${name} (${from}) replied: ${status}`, from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ADMIN_PHONE }).catch(() => {});
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    res.status(500).send('Error');
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
      const contact = db.getContact(phone);
      const firstName = contact?.name ? contact.name.split(' ')[0] : null;
      const greeting = firstName ? `Hi ${firstName}! ` : `Hi! `;
      const msgBody = `${greeting}${baseMsg}${suffix}`;
      await twilioClient.messages.create({ body: msgBody, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      console.error(`[BLAST ERROR] ${phone}:`, err.message);
      failed++;
    }
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

app.post('/contacts/import', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data' });
  try { res.json(importContacts(csv)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── EVENTS ────────────────────────────────────────────────────
app.get('/events', (req, res) => {
  const eventsFile = path.join(__dirname, 'data', 'events.json');
  try {
    const data = fs.existsSync(eventsFile) ? JSON.parse(fs.readFileSync(eventsFile, 'utf8')) : {};
    const list = Object.values(data).sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    res.json(list);
  } catch { res.json([]); }
});

// ── DELETE EVENT ──────────────────────────────────────────────
app.delete('/api/events/:eventId', (req, res) => {
  try {
    const { eventId } = req.params;
    const eventsFile = path.join(__dirname, 'data', 'events.json');
    const rsvpsFile  = path.join(__dirname, 'data', 'rsvps.json');
    if (fs.existsSync(eventsFile)) {
      const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
      if (!events[eventId]) return res.status(404).json({ error: 'Event not found' });
      delete events[eventId];
      fs.writeFileSync(eventsFile, JSON.stringify(events, null, 2));
    }
    if (fs.existsSync(rsvpsFile)) {
      const rsvps = JSON.parse(fs.readFileSync(rsvpsFile, 'utf8'));
      Object.keys(rsvps).forEach(phone => {
        if (rsvps[phone][eventId]) delete rsvps[phone][eventId];
      });
      fs.writeFileSync(rsvpsFile, JSON.stringify(rsvps, null, 2));
    }
    console.log(`[API] Deleted event: ${eventId}`);
    res.json({ success: true, deleted: eventId });
  } catch (err) {
    console.error('[API] Delete event error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── RSVPs ─────────────────────────────────────────────────────
app.get('/rsvps/latest', (req, res) => {
  const event = db.getLatestEvent();
  if (!event) return res.json({ event: null, rsvps: [] });
  res.json({ event, rsvps: db.getRsvpsForEvent(event.id) });
});

app.get('/rsvps/:eventId', (req, res) => res.json(db.getRsvpsForEvent(req.params.eventId)));

// ── DONORS (Stripe customers with saved cards) ────────────────
app.get('/api/donors', async (req, res) => {
  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

    // Fetch up to 100 customers tagged with sms-rsvp source
    const customers = await stripe.customers.search({
      query: `metadata['source']:'sms-rsvp'`,
      limit: 100,
      expand: ['data.sources']
    });

    const donors = await Promise.all(customers.data.map(async (customer) => {
      // Get saved payment methods for each customer
      let card = null;
      try {
        const methods = await stripe.paymentMethods.list({ customer: customer.id, type: 'card', limit: 1 });
        if (methods.data.length > 0) {
          const pm = methods.data[0].card;
          card = {
            brand: pm.brand,
            last4: pm.last4,
            expMonth: pm.exp_month,
            expYear: pm.exp_year
          };
        }
      } catch (e) { /* no card */ }

      // Get total donations from payment intents
      let totalDonated = 0;
      let donationCount = 0;
      let lastDonation = null;
      try {
        const intents = await stripe.paymentIntents.list({ customer: customer.id, limit: 100 });
        const succeeded = intents.data.filter(p => p.status === 'succeeded');
        totalDonated = succeeded.reduce((sum, p) => sum + p.amount, 0) / 100;
        donationCount = succeeded.length;
        if (succeeded.length > 0) {
          lastDonation = new Date(succeeded[0].created * 1000).toLocaleDateString();
        }
      } catch (e) { /* no payments */ }

      return {
        id: customer.id,
        name: customer.name || '—',
        phone: customer.metadata?.phone || customer.phone || '—',
        email: customer.email || '—',
        card,
        totalDonated,
        donationCount,
        lastDonation,
        created: new Date(customer.created * 1000).toLocaleDateString()
      };
    }));

    // Sort by total donated descending
    donors.sort((a, b) => b.totalDonated - a.totalDonated);
    res.json(donors);

  } catch (err) {
    console.error('[API] Donors error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DONATION SUCCESS PAGE ─────────────────────────────────────
app.get('/donation-success', (req, res) => {
  const amount = req.query.amount || '';
  const displayAmount = amount ? `$${amount}` : 'your donation';
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thank You!</title>
  <style>
    body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;background:#f9f4ec;}
    .card{background:white;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,0.08);}
    h1{color:#1565c0;font-size:28px;}p{color:#555;font-size:16px;line-height:1.6;}
    .icon{font-size:60px;margin-bottom:16px;}.amount{font-size:32px;font-weight:bold;color:#1565c0;margin:16px 0;}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🙏</div>
    <h1>Thank You!</h1>
    <div class="amount">${displayAmount}</div>
    <p>Your donation to Chabad of the Rivertowns has been received. A tax receipt is on its way to your email.</p>
    <p>Your generosity helps us build a stronger Jewish community in the Rivertowns.</p>
    <p style="margin-top:30px;color:#888;font-size:13px;">— Rabbi Benzion & Hinda Silverman</p>
  </div>
</body>
</html>`);
});

// ── DONATION CANCEL PAGE ──────────────────────────────────────
app.get('/donation-cancel', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>No Problem</title>
  <style>
    body{font-family:Arial,sans-serif;text-align:center;padding:60px 20px;background:#f9f4ec;}
    .card{background:white;border-radius:12px;padding:40px;max-width:400px;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,0.08);}
    h1{color:#555;font-size:24px;}p{color:#777;font-size:15px;line-height:1.6;}
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size:50px;margin-bottom:16px">↩️</div>
    <h1>No problem!</h1>
    <p>Your payment was cancelled. If you'd like to donate another time, just reply to any of our texts.</p>
    <p>Thank you for being part of our community!</p>
  </div>
</body>
</html>`);
});

// ── KEEP ALIVE ────────────────────────────────────────────────
const https = require('https');
setInterval(() => {
  const url = process.env.APP_URL;
  if (url) https.get(url).on('error', () => {});
}, 4 * 60 * 1000);

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✡️  Chabad SMS System running on port ${PORT}`);
  console.log(`   Twilio: ${process.env.TWILIO_PHONE_NUMBER} | Admin: ${process.env.ADMIN_PHONE}`);
}).on('error', (err) => { console.error('Server error:', err); process.exit(1); });
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
