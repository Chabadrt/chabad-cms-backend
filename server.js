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

// ── STRIPE WEBHOOK ────────────────────────────────────────
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.error(`[WEBHOOK] Sig failed: ${err.message}`); return res.status(400).send(`Webhook Error: ${err.message}`); }

  const isCheckout = event.type === 'checkout.session.completed';
  const isPaymentIntent = event.type === 'payment_intent.succeeded';

  if (isCheckout || isPaymentIntent) {
    const obj = event.data.object;
    const amount = isCheckout ? obj.amount_total / 100 : obj.amount / 100;
    let phone = obj.metadata?.phone;

    if (!phone) {
      try {
        const convsFile = path.join(__dirname, 'data', 'conversations.json');
        if (fs.existsSync(convsFile)) {
          const convs = JSON.parse(fs.readFileSync(convsFile, 'utf8'));
          const match = Object.values(convs).find(c => ['await_ticket_payment','await_donation_after_ticket','await_donation_payment'].includes(c.step));
          if (match) phone = match.phone;
        }
      } catch (e) { console.error('[WEBHOOK] Conv lookup:', e.message); }
    }

    console.log(`[WEBHOOK] ${event.type} $${amount} phone:${phone}`);

    if (phone) {
      try {
        const s = getSettings();
        const contact = db.getContact(phone);
        const firstName = contact?.name ? contact.name.split(' ')[0] : null;
        const conv = db.getConversation(phone);
        const eventObj = conv.eventId ? db.getEvent(conv.eventId) : db.getLatestEvent();
        const confirmation = eventObj
          ? `You're all set! See you at ${eventObj.name} ${eventObj.date} @ ${eventObj.time}. ${s.confirmationNote||''}`.trim()
          : `You're all set! 🙏`;

        console.log(`[WEBHOOK] conv.step:${conv.step}`);

        if (conv.step === 'await_ticket_payment') {
          const receipt = await getReceiptText(amount, firstName, 'event', s.receiptMessage||null);
          await smsOut(phone, `${receipt}\n\n${confirmation}`);
          markRsvpPaid(phone, conv.eventId, amount);
          db.clearConversation(phone);

        } else if (conv.step === 'await_donation_after_ticket') {
          const receipt = await getReceiptText(amount, firstName, 'event', s.receiptMessage||null);
          await smsOut(phone, receipt);
          markRsvpPaid(phone, conv.eventId, amount);
          if (eventObj) {
            db.saveConversation(phone, { step: 'await_donation_decision', eventId: conv.eventId });
            const donationAsk = s.donationAsk || 'Would you like to make a donation?';
            await smsOut(phone, `${donationAsk}\n\n${buildDonationMenu(eventObj, s)}`);
          } else { db.clearConversation(phone); await smsOut(phone, confirmation); }

        } else if (conv.step === 'await_donation_payment') {
          const receipt = await getReceiptText(amount, firstName, 'donation', s.receiptMessage||null);
          await smsOut(phone, `${receipt}\n\n${confirmation}`);
          if (conv.eventId) db.saveRsvp(conv.eventId, phone, { donationAmount: amount });
          db.clearConversation(phone);

        } else {
          const receipt = await getReceiptText(amount, firstName, s.receiptType||'donation', s.receiptMessage||null);
          await smsOut(phone, receipt);
          markRsvpPaid(phone, conv.eventId, amount);
          db.clearConversation(phone);
        }
      } catch (err) { console.error('[WEBHOOK] Error:', err.message); }

      if (process.env.ADMIN_PHONE) {
        try { const c = db.getContact(phone); await twilioClient.messages.create({ body: `💰 Payment $${amount} from ${c?.name||phone}`, from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ADMIN_PHONE }); }
        catch (e) {}
      }
    }
  }
  res.json({ received: true });
});

async function smsOut(to, body) {
  await twilioClient.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to });
  console.log(`[SMS OUT] → ${to}: "${body.substring(0,60)}..."`);
}

function buildDonationMenu(event, s) {
  const amounts = event?.donationAmounts || [5, 10, 18];
  let menu = '';
  amounts.forEach((amt, i) => { menu += `${i+1} — ${amt===18?'$18 (Chai ✡️)':'$'+amt}\n`; });
  if (event?.useFreeform !== false) menu += `Or reply with any amount (e.g. $36)\n`;
  menu += `N — No thank you`;
  return menu;
}

function markRsvpPaid(phone, eventId, amount) {
  try {
    const rsvpsFile = path.join(__dirname, 'data', 'rsvps.json');
    if (!fs.existsSync(rsvpsFile)) return;
    const rsvps = JSON.parse(fs.readFileSync(rsvpsFile, 'utf8'));
    const targetId = eventId || Object.keys(rsvps).find(eid => rsvps[eid][phone]);
    if (targetId && rsvps[targetId]?.[phone]) { rsvps[targetId][phone].paymentStatus='paid'; rsvps[targetId][phone].paidAt=new Date().toISOString(); fs.writeFileSync(rsvpsFile, JSON.stringify(rsvps,null,2)); }
  } catch (err) { console.error('[MARK PAID]', err.message); }
}

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.get('/', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/settings', (req, res) => res.json(getSettings()));
app.post('/settings', (req, res) => { try { res.json({ success: true, settings: saveSettings(req.body) }); } catch (err) { res.status(500).json({ error: err.message }); } });

// ── INCOMING SMS ──────────────────────────────────────────
app.post('/sms/incoming', async (req, res) => {
  const from = req.body.From, body = req.body.Body;
  if (!from || !body) return res.status(400).send('Missing From or Body');
  const msgLower = body.trim().toLowerCase();
  if (['stop','unsubscribe','cancel','end','quit'].includes(msgLower)) {
    db.saveContact(from, { unsubscribed: true, unsubscribedAt: new Date().toISOString() });
    db.clearConversation(from);
    return res.status(200).send('OK');
  }
  if (msgLower === 'start') { db.saveContact(from, { unsubscribed: false }); return res.status(200).send('OK'); }
  try {
    const reply = await handleIncoming(from, body);
    await twilioClient.messages.create({ body: reply, from: process.env.TWILIO_PHONE_NUMBER, to: from });
    if (body.trim() === '1' || body.trim() === '2') {
      const contact = db.getContact(from);
      await twilioClient.messages.create({ body: `[RSVP] ${contact?.name||from}: ${body.trim()==='1'?'✅ YES':'❌ No'}`, from: process.env.TWILIO_PHONE_NUMBER, to: process.env.ADMIN_PHONE }).catch(()=>{});
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[INCOMING]', err.message);
    try { await twilioClient.messages.create({ body: `Sorry, something went wrong. Please try again or call (914) 330-1307.`, from: process.env.TWILIO_PHONE_NUMBER, to: from }); } catch (e) {}
    res.status(200).send('OK');
  }
});

// ── BLAST ─────────────────────────────────────────────────
app.post('/blast', async (req, res) => {
  const { event, phones } = req.body;
  if (!event || !phones?.length) return res.status(400).json({ error: 'Missing event or phones' });
  const s = getSettings();
  const eventId = `evt_${Date.now()}`;
  db.saveEvent({ id: eventId, ...event, sentAt: new Date().toISOString(), sentTo: phones.length });

  // For announcements, no RSVP prompt
  const isAnnouncement = event.eventType === 'announcement';
  const baseMsg = isAnnouncement
    ? event.customMessage || ''
    : `${s.botIntro}\n\nWill you be joining us for ${event.name} ${event.date} @ ${event.time}?${event.customMessage ? '\n\n' + event.customMessage : ''}\n\n${s.rsvpPrompt}`;

  let sent = 0, failed = 0;
  for (const phone of phones) {
    try {
      const contact = db.getContact(phone);
      if (contact?.unsubscribed) { failed++; continue; }
      const firstName = contact?.name ? contact.name.split(' ')[0] : null;
      const greeting = isAnnouncement ? (firstName ? `Hi ${firstName}! ` : 'Hi! ') : (firstName ? `Hi ${firstName}! ` : 'Hi! ');
      const msgBody = `${greeting}${baseMsg}`;
      await twilioClient.messages.create({ body: msgBody, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
      db.saveContact(phone, { lastEventId: eventId, lastBlastAt: new Date().toISOString() });
      db.clearConversation(phone);
      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) { console.error(`[BLAST] ${phone}:`, err.message); failed++; }
  }
  res.json({ success: true, eventId, sent, failed });
});

// ── CONTACTS ─────────────────────────────────────────────
app.get('/contacts', (req, res) => res.json(db.getAllContacts()));
app.post('/contacts', (req, res) => { const { phone, name, lists } = req.body; if (!phone) return res.status(400).json({ error: 'Phone required' }); res.json(db.saveContact(phone, { name, lists: lists||['all'] })); });
app.patch('/contacts/:phone', (req, res) => { const phone = decodeURIComponent(req.params.phone); if (!req.body.lists) return res.status(400).json({ error: 'lists required' }); res.json(db.saveContact(phone, { lists: req.body.lists })); });
app.delete('/contacts/:phone', (req, res) => { try { db.deleteContact(decodeURIComponent(req.params.phone)); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/contacts/bulk-delete', (req, res) => { const { phones } = req.body; if (!phones?.length) return res.status(400).json({ error: 'phones required' }); try { db.bulkDeleteContacts(phones); res.json({ success: true, deleted: phones.length }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/contacts/bulk-remove-from-list', (req, res) => { const { phones, listId } = req.body; if (!phones?.length||!listId) return res.status(400).json({ error: 'phones and listId required' }); try { db.removeContactsFromList(phones, listId); res.json({ success: true, removed: phones.length }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/contacts/import', (req, res) => { const { csv, mapping, listId, listName } = req.body; if (!csv) return res.status(400).json({ error: 'No CSV data' }); try { res.json(importContacts(csv, mapping||{}, listId, listName)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post('/contacts/csv-preview', (req, res) => { const { csv } = req.body; if (!csv) return res.status(400).json({ error: 'No CSV data' }); try { const { getCSVPreview } = require('./import'); res.json(getCSVPreview(csv, 3)); } catch (err) { res.status(500).json({ error: err.message }); } });

// ── EVENTS ────────────────────────────────────────────────
app.get('/events', (req, res) => { const f = path.join(__dirname,'data','events.json'); try { const d = fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};  res.json(Object.values(d).sort((a,b)=>new Date(b.sentAt)-new Date(a.sentAt))); } catch { res.json([]); } });
app.delete('/api/events/:eventId', (req, res) => {
  try {
    const { eventId } = req.params;
    const ef = path.join(__dirname,'data','events.json'), rf = path.join(__dirname,'data','rsvps.json');
    if (fs.existsSync(ef)) { const e=JSON.parse(fs.readFileSync(ef,'utf8')); if (!e[eventId]) return res.status(404).json({error:'Not found'}); delete e[eventId]; fs.writeFileSync(ef,JSON.stringify(e,null,2)); }
    if (fs.existsSync(rf)) { const r=JSON.parse(fs.readFileSync(rf,'utf8')); delete r[eventId]; fs.writeFileSync(rf,JSON.stringify(r,null,2)); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RSVPs ─────────────────────────────────────────────────
app.get('/rsvps/latest', (req, res) => { const e=db.getLatestEvent(); if (!e) return res.json({event:null,rsvps:[]}); res.json({event:e,rsvps:db.getRsvpsForEvent(e.id)}); });
app.get('/rsvps/:eventId', (req, res) => res.json(db.getRsvpsForEvent(req.params.eventId)));

// ── KEEP ALIVE ────────────────────────────────────────────
const https = require('https');
setInterval(() => { const url = process.env.APP_URL; if (url) https.get(url).on('error',()=>{}); }, 4*60*1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log(`✡️  Chabad SMS running on port ${PORT}`); }).on('error', err => { console.error('Server error:', err); process.exit(1); });
process.on('uncaughtException', err => { console.error('Uncaught:', err); });
