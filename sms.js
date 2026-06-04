// sms.js — Conversation brain using editable settings

const db = require('./db');
const { getSettings } = require('./settings');

function parseYesNo(msg) {
  const m = msg.toLowerCase().trim();
  const yesWords = ['1', 'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay',
    'definitely', 'absolutely', 'of course', 'coming', 'count me in',
    'im in', "i'm in", 'iyh', "iy\"h", 'bezras hashem', 'be there',
    "i'll be there", 'ill be there', 'will be there'];
  const noWords = ['2', 'no', 'nope', 'cant', "can't", 'cannot', 'sorry',
    'unfortunately', 'not this time', "won't", 'unable', 'not coming', 'skip'];
  for (const w of yesWords) { if (m === w || m.includes(w)) return 'yes'; }
  for (const w of noWords) { if (m === w || m.includes(w)) return 'no'; }
  return null;
}

function parseDonation(msg) {
  const m = msg.toLowerCase().trim();
  if (m === '1' || m === '$5' || m === '5') return 5;
  if (m === '2' || m === '$10' || m === '10') return 10;
  if (m === '3' || m === '$18' || m === '18' || m === 'chai') return 18;
  const skipWords = ['n', 'no', 'skip', 'pass', 'next time', 'not now', 'nope'];
  for (const w of skipWords) { if (m === w || m.includes(w)) return 'skip'; }
  const num = parseFloat(msg.replace(/[$,\s]/g, ''));
  if (!isNaN(num) && num > 0 && num <= 10000) return Math.round(num * 100) / 100;
  return null;
}

async function handleIncoming(from, body) {
  const phone = from.trim();
  const msg = body.trim();
  const conv = db.getConversation(phone);
  const contact = db.getContact(phone);
  const s = getSettings();

  console.log(`[SMS IN] ${phone} | step: ${conv.step} | msg: "${msg}"`);

  switch (conv.step) {
    case 'idle': return handleIdle(phone, msg, contact, conv, s);
    case 'await_headcount': return handleHeadcount(phone, msg, contact, conv, s);
    case 'await_donation_decision': return handleDonationDecision(phone, msg, contact, conv, s);
    case 'await_donation_confirm': return handleDonationConfirm(phone, msg, contact, conv, s);
    case 'await_donation_amount': return handleDonationAmount(phone, msg, contact, conv, s);
    default: return handleIdle(phone, msg, contact, conv, s);
  }
}

async function handleIdle(phone, msg, contact, conv, s) {
  const event = db.getLatestEvent();
  if (!event) return `Thanks for texting Chabad of the Rivertowns! Stay tuned for upcoming events. 💛\n\nReply STOP to unsubscribe.`;

  const answer = parseYesNo(msg);

  if (answer === 'yes') {
    db.saveRsvp(event.id, phone, { name: contact?.name || 'Guest', status: 'yes' });
    if (event.askHeadcount) {
      db.saveConversation(phone, { step: 'await_headcount', eventId: event.id });
      return `Wonderful! How many people will be joining you? (Please reply with just a number)`;
    } else if (event.askDonation) {
      return await startDonationFlow(phone, contact, event, s);
    } else {
      db.clearConversation(phone);
      return confirmationMessage(event, s);
    }
  }

  if (answer === 'no') {
    db.saveRsvp(event.id, phone, { name: contact?.name || 'Guest', status: 'no' });
    db.clearConversation(phone);
    return s.noReply;
  }

  return s.unrecognizedReply;
}

async function handleHeadcount(phone, msg, contact, conv, s) {
  const count = parseInt(msg.replace(/[^0-9]/g, ''));
  if (isNaN(count) || count < 1 || count > 50) {
    return `Please reply with just a number for how many people are joining you (e.g. 2).`;
  }
  const event = db.getEvent(conv.eventId);
  db.saveRsvp(conv.eventId, phone, { guestCount: count });
  if (event?.askDonation) {
    db.saveConversation(phone, { ...conv, step: 'await_donation_decision', guestCount: count });
    return await startDonationFlow(phone, contact, event, s);
  }
  db.clearConversation(phone);
  return confirmationMessage(event, s);
}

async function startDonationFlow(phone, contact, event, s) {
  db.saveConversation(phone, { step: 'await_donation_decision', eventId: event.id });
  return `${s.donationAsk}\n\n${s.donationAmounts}`;
}

async function handleDonationDecision(phone, msg, contact, conv, s) {
  const event = db.getEvent(conv.eventId);
  const amount = parseDonation(msg);

  if (amount === 'skip') {
    db.clearConversation(phone);
    return confirmationMessage(event, s);
  }
  if (amount === null) {
    return `Please reply with 1 ($5), 2 ($10), 3 ($18 Chai), or N to skip.`;
  }

  const link = s.donationLink;
  db.saveRsvp(conv.eventId, phone, { donationAmount: amount });
  db.clearConversation(phone);
  return `Here's your secure payment link for $${amount}:\n🔗 ${link}\n\nYour card will be saved for future events — next time it's just one tap! 💛\n\n${confirmationMessage(event, s)}`;
}

async function handleDonationConfirm(phone, msg, contact, conv, s) {
  db.clearConversation(phone);
  return confirmationMessage(db.getEvent(conv.eventId), s);
}

async function handleDonationAmount(phone, msg, contact, conv, s) {
  const event = db.getEvent(conv.eventId);
  const amount = parseDonation(msg);
  if (amount === 'skip') { db.clearConversation(phone); return confirmationMessage(event, s); }
  if (amount === null) return `Please reply with 1 ($5), 2 ($10), 3 ($18 Chai), or N to skip.`;
  const link = s.donationLink;
  db.saveRsvp(conv.eventId, phone, { donationAmount: amount });
  db.clearConversation(phone);
  return `Here's your secure payment link for $${amount}:\n🔗 ${link}\n\nYour card will be saved for future events — next time it's just one tap! 💛\n\n${confirmationMessage(event, s)}`;
}

function confirmationMessage(event, s) {
  if (!event) return `You're all set! See you soon. 🙏`;
  return `You're all set! See you at ${event.name} ${event.date} @ ${event.time}. ${s.confirmationNote}`;
}

module.exports = { handleIncoming };
