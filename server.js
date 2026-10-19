require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const path = require('path');
const fs = require('fs');
const { handleIncoming } = require('./sms');
const { importContacts } = require('./import');
const { getSettings, saveSettings } = require('./settings');
const { getReceiptText, SIGN_OFF, getOrCreateCustomer, createPaymentLink } = require('./payments');
const db = require('./db');

const app = express();

// ── ONE-TIME FIX (Oct 18 2026): the Friday Oct 23 Shabbat dinner blast went out with a $2 test ticket price.
// Set the real prices on those events at startup. Safe to run repeatedly; remove after it has run once.
try {
  for (const id of ['evt_1792368537032', 'evt_1792368435264']) {
    const ev = db.getEvent(id);
    if (ev && Array.isArray(ev.tickets) && ev.tickets.length === 1 && ev.tickets[0].label === 'Adult' && Number(ev.tickets[0].price) === 2) {
      ev.tickets = [{ label: 'Adult', price: 55 }, { label: 'Child', price: 15 }];
      db.saveEvent(ev);
      console.log(`[FIX] ${id} ticket prices set to Adult $55, Child $15`);
    }
  }
} catch (e) { console.error('[FIX] ticket price fix failed:', e.message); }

// ONE-TIME FIX (Oct 18 2026): Beth Fossner's 2 Adult tickets were quoted at the old $2 test price ($4).
// Deactivate that link and issue a $110 link ($55 x 2). Runs once: skipped when her ticketPrice is no longer 4.
(async () => {
  try {
    const evId = 'evt_1792368537032', phone = '+16466752565';
    const rsvp = db.getRsvpsForEvent(evId).find(r => r.phone === phone);
    if (!rsvp || Number(rsvp.ticketPrice) !== 4 || rsvp.paymentStatus !== 'pending' || rsvp.ticketType !== '2x Adult') return;
    const ev = db.getEvent(evId); const contact = db.getContact(phone);
    const oldLink = rsvp.ticketPaymentLink;
    const customerId = await getOrCreateCustomer(phone, contact?.name);
    const link = await createPaymentLink(110, `${ev.name.trim()} — 2x Adult`, customerId, phone, true);
    db.saveRsvp(evId, phone, { ticketPrice: 110, ticketPaymentLink: link, oldTicketPaymentLink: oldLink });
    db.saveConversation(phone, { step: 'await_ticket_payment', eventId: evId });
    console.log(`[FIX] Beth Fossner new $110 link created: ${link}`);
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const links = await stripe.paymentLinks.list({ limit: 100 });
      const old = links.data.find(l => l.url === oldLink);
      if (old) { await stripe.paymentLinks.update(old.id, { active: false }); console.log('[FIX] old $4 link deactivated'); }
    } catch (e) { console.error('[FIX] could not deactivate old link:', e.message); }
  } catch (e) { console.error('[FIX] Beth link fix failed:', e.message); }
})();

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ── STRIPE WEBHOOK ────────────────────────────────────────
const handledPayments = new Set();
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

    // A single payment-link payment fires BOTH checkout.session.completed and payment_intent.succeeded.
    // Only act on the first one we see for each payment, or the person gets two texts.
    const paymentKey = (isCheckout ? obj.payment_intent : obj.id) || obj.id;
    if (handledPayments.has(paymentKey)) {
      console.log(`[WEBHOOK] ${event.type} skipped, payment ${paymentKey} already handled`);
      return res.json({ received: true, duplicate: true });
    }
    handledPayments.add(paymentKey);
    if (handledPayments.size > 500) handledPayments.delete(handledPayments.values().next().value);

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
          const receipt = await getReceiptText(amount, firstName, 'event', s.receiptMessage||null, { noClosing: true });
          await smsOut(phone, `${receipt}\n\n${confirmation}${SIGN_OFF}`);
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
          const receipt = await getReceiptText(amount, firstName, 'donation', s.receiptMessage||null, { noClosing: true });
          await smsOut(phone, `${receipt}\n\n${confirmation}${SIGN_OFF}`);
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

// Twilio calls this back with delivery status; error 21610 means the carrier or
// Twilio's own opt-out list blocked the send because that number unsubscribed,
// even if our own STOP/unsubscribe keyword matching never saw it happen.
function statusCallbackUrl() {
  return process.env.APP_URL ? `${process.env.APP_URL.replace(/\/$/, '')}/sms/status` : undefined;
}

async function smsOut(to, body) {
  await twilioClient.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to, statusCallback: statusCallbackUrl() });
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
    await twilioClient.messages.create({ body: reply, from: process.env.TWILIO_PHONE_NUMBER, to: from, statusCallback: statusCallbackUrl() });
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

// ── SMS STATUS CALLBACK ───────────────────────────────────
// Twilio posts delivery status here for every outbound message that included
// a statusCallback. ErrorCode 21610 = Twilio/carrier blocked the send because
// that number is on an opt-out list, which can happen even when our own
// STOP-keyword matching in /sms/incoming never saw the opt-out come through.
app.post('/sms/status', (req, res) => {
  const to = req.body.To, errorCode = req.body.ErrorCode;
  if (to && String(errorCode) === '21610') {
    db.saveContact(to, { unsubscribed: true, unsubscribedAt: new Date().toISOString(), unsubscribedVia: 'twilio' });
    console.log(`[SMS STATUS] ${to} opted out at Twilio/carrier level (21610) — marked unsubscribed`);
  }
  res.status(200).send('OK');
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
  // If a custom message is written on a non-announcement blast, it replaces the greeting,
  // bot intro and auto-generated question. The RSVP prompt is still appended.
  const hasCustom = !isAnnouncement && !!(event.customMessage && event.customMessage.trim());
  const baseMsg = isAnnouncement
    ? event.customMessage || ''
    : hasCustom
      ? `${event.customMessage.trim()}\n\n${s.rsvpPrompt}`
      : `${s.botIntro}\n\nWill you be joining us for ${event.name} ${event.date} @ ${event.time}?\n\n${s.rsvpPrompt}`;

  let sent = 0, failed = 0;
  for (const phone of phones) {
    try {
      const contact = db.getContact(phone);
      if (contact?.unsubscribed) { failed++; continue; }
      const firstName = contact?.name ? contact.name.split(' ')[0] : null;
      const greeting = hasCustom ? '' : (firstName ? `Hi ${firstName}! ` : 'Hi! ');
      const msgBody = `${greeting}${baseMsg}`.replace(/\{first_name\}/gi, firstName || 'there');
      await twilioClient.messages.create({ body: msgBody, from: process.env.TWILIO_PHONE_NUMBER, to: phone, statusCallback: statusCallbackUrl() });
      db.saveContact(phone, { lastEventId: eventId, lastBlastAt: new Date().toISOString() });
      db.clearConversation(phone);
      sent++;
      await new Promise(r => setTimeout(r, 50));
    } catch (err) {
      console.error(`[BLAST] ${phone}:`, err.message);
      if (err.code === 21610) db.saveContact(phone, { unsubscribed: true, unsubscribedAt: new Date().toISOString(), unsubscribedVia: 'twilio' });
      failed++;
    }
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
app.post('/contacts/import', (req, res) => {
  const { csv, mapping, listId, listName, mergeLists } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV data' });
  // Default to merging so an import never silently strips someone's existing lists
  const merge = mergeLists !== false;
  try { res.json(importContacts(csv, mapping||{}, listId, listName, merge)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
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
