// server.js — The main server.

require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const path = require('path');
const { handleIncoming } = require('./sms');
const { importContacts } = require('./import');
const db = require('./db');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'Chabad Rivertowns SMS System', time: new Date().toISOString() });
});

// ── DASHBOARD ─────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ── INCOMING SMS WEBHOOK ──────────────────────────────────
app.post('/sms/incoming', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  if (!from || !body) return res.status(400).send('Missing From or Body');
  try {
    const reply = await handleIncoming(from, body);
    console.log(`[SMS OUT] → ${from}: "${reply}"`);
    await twilioClient.messages.create({
      body: reply,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from
    });
    const msg = body.trim();
    if (msg === '1' || msg === '2') {
      const contact = db.getContact(from);
      const name = contact?.name || from;
      const status = msg === '1' ? '✅ YES' : '❌ No';
      await twilioClient.messages.create({
        body: `[RSVP] ${name} (${from}) replied: ${status}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.ADMIN_PHONE
      }).catch(() => {});
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    res.status(500).send('Error');
  }
});

// ── SEND BLAST ────────────────────────────────────────────
app.post('/blast', async (req, res) => {
  const { event, phones } = req.body;
  if (!event || !phones?.length) return res.status(400).json({ error: 'Missing event or phones' });
  const eventId = `evt_${Date.now()}`;
  const fullEvent = { id: eventId, ...event, sentAt: new Date().toISOString(), sentTo: phones.length };
  db.saveEvent(fullEvent);
  let msgBody = `Hi! This is Rabbi Benjy's new texting bot 🤖\n(yes, the Rabbi has been having a little too much fun with AI lately 😄)\n\n`;
  msgBody += `Will you be joining us for ${event.name}`;
  if (event.date) msgBody += ` — ${event.date}`;
  if (event.time) msgBody += ` at ${event.time}`;
  if (event.location) msgBody += ` at ${event.location}`;
  msgBody += '.';
  if (event.customMessage) msgBody += `\n\n${event.customMessage}`;
  msgBody += `\n\nPlease reply with just a number:\n1 — I'll be there 🙏\n2 — Can't make it this time`;
  let sent = 0, failed = 0;
  for (const phone of phones) {
    try {
      await twilioClient.messages.create({ body: msgBody, from: process.env.TWILIO_PHONE_NUMBER, to: phone });
      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      console.error(`[BLAST ERROR] ${phone}:`, err.message);
      failed++;
    }
  }
  console.log(`[BLAST] "${event.name}" — sent: ${sent}, failed: ${failed}`);
  res.json({ success: true, eventId, sent, failed });
});

// ── CONTACTS API ──────────────────────────────────────────
app.get('/contacts', (req, res) => {
  res.json(db.getAllContacts());
});

app.post('/contacts', (req, res) => {
  const { phone, name, lists } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const contact = db.saveContact(phone, { name, lists: lists || ['all'] });
  res.json(contact);
});

app.post('/contacts/import', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data provided' });
  try {
    const results = importContacts(csv);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RSVPs API ─────────────────────────────────────────────
app.get('/rsvps/:eventId', (req, res) => {
  res.json(db.getRsvpsForEvent(req.params.eventId));
});

app.get('/rsvps/latest', (req, res) => {
  const event = db.getLatestEvent();
  if (!event) return res.json({ event: null, rsvps: [] });
  res.json({ event, rsvps: db.getRsvpsForEvent(event.id) });
});

// ── KEEP ALIVE ────────────────────────────────────────────
const https = require('https');
setInterval(() => {
  const url = process.env.APP_URL;
  if (url) https.get(url).on('error', () => {});
}, 4 * 60 * 1000);

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✡️  Chabad SMS System running on port ${PORT}`);
  console.log(`   Twilio number: ${process.env.TWILIO_PHONE_NUMBER}`);
  console.log(`   Admin phone:   ${process.env.ADMIN_PHONE}`);
}).on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
