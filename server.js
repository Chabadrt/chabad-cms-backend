// server.js — The main server.
// Handles incoming SMS webhooks from Twilio and the admin API for sending blasts.

require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const { handleIncoming } = require('./sms');
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

// ── INCOMING SMS WEBHOOK ──────────────────────────────────
// Twilio calls this URL every time someone texts your number.
// Set this as your Webhook URL in Twilio: https://your-app.railway.app/sms/incoming

app.post('/sms/incoming', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  if (!from || !body) {
    return res.status(400).send('Missing From or Body');
  }

  try {
    const reply = await handleIncoming(from, body);
    console.log(`[SMS OUT] → ${from}: "${reply}"`);

    // Send reply via Twilio
    await twilioClient.messages.create({
      body: reply,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from
    });

    // Notify admin on every RSVP (optional — remove if too many texts)
    const msg = body.trim();
    if (msg === '1' || msg === '2') {
      const contact = db.getContact(from);
      const name = contact?.name || from;
      const status = msg === '1' ? '✅ YES' : '❌ No';
      await twilioClient.messages.create({
        body: `[RSVP] ${name} (${from}) replied: ${status}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.ADMIN_PHONE
      }).catch(() => {}); // Don't crash if admin notify fails
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    res.status(500).send('Error');
  }
});

// ── SEND BLAST ────────────────────────────────────────────
// Called by the dashboard when you click "Send Blast Now"
// POST /blast with event details + list of phone numbers

app.post('/blast', async (req, res) => {
  const { event, phones } = req.body;

  if (!event || !phones?.length) {
    return res.status(400).json({ error: 'Missing event or phones' });
  }

  // Save the event
  const eventId = `evt_${Date.now()}`;
  const fullEvent = {
    id: eventId,
    ...event,
    sentAt: new Date().toISOString(),
    sentTo: phones.length
  };
  db.saveEvent(fullEvent);

  // Build the message
  const msgBody = buildBlastMessage(fullEvent);

  // Send to all phones
  let sent = 0, failed = 0;
  for (const phone of phones) {
    try {
      await twilioClient.messages.create({
        body: msgBody,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone
      });
      sent++;
      // Small delay to avoid Twilio rate limits
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      console.error(`[BLAST ERROR] ${phone}:`, err.message);
      failed++;
    }
  }

  console.log(`[BLAST] Event "${event.name}" — sent: ${sent}, failed: ${failed}`);
  res.json({ success: true, eventId, sent, failed });
});

function buildBlastMessage(event) {
  let msg = `🕯️ You're invited to our ${event.name}`;
  if (event.date) msg += ` — ${event.date}`;
  if (event.time) msg += ` at ${event.time}`;
  if (event.location) msg += ` at ${event.location}`;
  msg += '.';
  if (event.customMessage) msg += `\n\n${event.customMessage}`;
  msg += `\n\nReply 1 to RSVP ✓\nReply 2 if you can't make it`;
  return msg;
}

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

// ── RSVPs API ─────────────────────────────────────────────
app.get('/rsvps/:eventId', (req, res) => {
  const rsvps = db.getRsvpsForEvent(req.params.eventId);
  res.json(rsvps);
});

app.get('/rsvps/latest', (req, res) => {
  const event = db.getLatestEvent();
  if (!event) return res.json([]);
  const rsvps = db.getRsvpsForEvent(event.id);
  res.json({ event, rsvps });
});

// Keep-alive ping to prevent sleeping
const https = require('https');
setInterval(() => {
  const url = process.env.APP_URL;
  if (url) {
    https.get(url).on('error', () => {});
  }
}, 4 * 60 * 1000);

// ── START ──────────────────────────────────────────────────
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
