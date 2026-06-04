require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const path = require('path');
const { handleIncoming } = require('./sms');
const { importContacts } = require('./import');
const { getSettings, saveSettings } = require('./settings');
const db = require('./db');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.get('/', (req, res) => res.json({ status: 'ok', name: 'Chabad Rivertowns SMS System', time: new Date().toISOString() }));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ── SETTINGS API ──────────────────────────────────────────
app.get('/settings', (req, res) => res.json(getSettings()));
app.post('/settings', (req, res) => {
  try {
    const updated = saveSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── INCOMING SMS ──────────────────────────────────────────
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

// ── BLAST ─────────────────────────────────────────────────
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
      const firstName = contact?.name ? contact.name.split(" ")[0] : null;
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

// ── CONTACTS ──────────────────────────────────────────────
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
  const contact = db.saveContact(phone, { lists });
  res.json(contact);
});
app.post('/contacts/import', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data' });
  try { res.json(importContacts(csv)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── RSVPs ─────────────────────────────────────────────────
app.get('/rsvps/latest', (req, res) => {
  const event = db.getLatestEvent();
  if (!event) return res.json({ event: null, rsvps: [] });
  res.json({ event, rsvps: db.getRsvpsForEvent(event.id) });
});
app.get('/rsvps/:eventId', (req, res) => res.json(db.getRsvpsForEvent(req.params.eventId)));
app.get('/events', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const eventsFile = path.join(__dirname, 'data', 'events.json');
  try {
    const data = fs.existsSync(eventsFile) ? JSON.parse(fs.readFileSync(eventsFile, 'utf8')) : {};
    const list = Object.values(data).sort((a,b) => new Date(b.sentAt) - new Date(a.sentAt));
    res.json(list);
  } catch { res.json([]); }
});
  // Load all events from file
  const fs = require('fs');
  const path = require('path');
  const eventsFile = path.join(__dirname, 'data', 'events.json');
  try {
    const data = fs.existsSync(eventsFile) ? JSON.parse(fs.readFileSync(eventsFile, 'utf8')) : {};
    const list = Object.values(data).sort((a,b) => new Date(b.sentAt) - new Date(a.sentAt));
    res.json(list);
  } catch { res.json([]); }
});

// ── KEEP ALIVE ────────────────────────────────────────────
const https = require('https');
setInterval(() => { const url = process.env.APP_URL; if (url) https.get(url).on('error', () => {}); }, 4 * 60 * 1000);

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✡️  Chabad SMS System running on port ${PORT}`);
  console.log(`   Twilio: ${process.env.TWILIO_PHONE_NUMBER} | Admin: ${process.env.ADMIN_PHONE}`);
}).on('error', (err) => { console.error('Server error:', err); process.exit(1); });
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
