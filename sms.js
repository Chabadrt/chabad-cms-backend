const db = require('./db');
const { getSettings } = require('./settings');

function getFirstName(contact) {
  if (!contact?.name) return null;
  return contact.name.split(' ')[0];
}

function personalize(template, contact) {
  const first = getFirstName(contact);
  if (!first) return template;
  return template.replace(/\{first_name\}/gi, first);
}

function parseYesNo(msg) {
  const m = msg.toLowerCase().trim();
  const yesWords = ['1','yes','yeah','yep','yup','sure','ok','okay','definitely','absolutely','of course','coming','count me in','im in',"i'm in",'iyh',"iy\"h",'bezras hashem','be there',"i'll be there",'ill be there','will be there'];
  const noWords = ['2','no','nope','cant',"can't",'cannot','sorry','unfortunately','not this time',"won't",'unable','not coming','skip'];
  for (const w of yesWords) { if (m === w || m.includes(w)) return 'yes'; }
  for (const w of noWords) { if (m === w || m.includes(w)) return 'no'; }
  return null;
}

function parseDonation(msg, event) {
  const m = msg.toLowerCase().trim();
  const amounts = event?.donationAmounts || [5, 10, 18];

  // Skip signals
  const skipWords = ['n','no','skip','pass','next time','not now','nope'];
  for (const w of skipWords) { if (m === w || m.includes(w)) return 'skip'; }

  // Preset number replies (1, 2, 3)
  if (m === '1' && amounts[0]) return amounts[0];
  if (m === '2' && amounts[1]) return amounts[1];
  if (m === '3' && amounts[2]) return amounts[2];

  // Direct amount match against preset amounts
  for (const amt of amounts) {
    if (m === `$${amt}` || m === `${amt}`) return amt;
  }

  // Free-form — any dollar amount
  const cleaned = msg.replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  if (!isNaN(num) && num > 0 && num <= 100000) return Math.round(num * 100) / 100;

  return null;
}

function buildDonationMenu(event, s) {
  const amounts = event?.donationAmounts || [5, 10, 18];
  const usePreset = !event?.donationAmounts || event.donationAmounts.length > 0;
  const useFreeform = event?.useFreeform !== false; // default true
  const usePresetToggle = event?.donationAmounts !== null && amounts.length > 0;

  let menu = '';
  if (usePresetToggle) {
    amounts.forEach((amt, i) => {
      const label = amt === 18 ? `$18 (Chai ✡️)` : `$${amt}`;
      menu += `${i + 1} — ${label}\n`;
    });
  }
  if (useFreeform) {
    menu += `Or reply with any amount (e.g. $36)\n`;
  }
  menu += `N — No thank you`;
  return menu;
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
      const first = getFirstName(contact);
      return `Wonderful${first ? ', ' + first : ''}! How many people will be joining you? (Please reply with just a number)`;
    } else if (event.askDonation) {
      return await startDonationFlow(phone, contact, event, s);
    } else {
      db.clearConversation(phone);
      return confirmationMessage(event, s, contact);
    }
  }
  if (answer === 'no') {
    db.saveRsvp(event.id, phone, { name: contact?.name || 'Guest', status: 'no' });
    db.clearConversation(phone);
    return personalize(s.noReply, contact);
  }
  return personalize(s.unrecognizedReply, contact);
}

async function handleHeadcount(phone, msg, contact, conv, s) {
  const count = parseInt(msg.replace(/[^0-9]/g, ''));
  if (isNaN(count) || count < 1 || count > 50) return `Please reply with just a number (e.g. 2).`;
  const event = db.getEvent(conv.eventId);
  db.saveRsvp(conv.eventId, phone, { guestCount: count });
  if (event?.askDonation) {
    db.saveConversation(phone, { ...conv, step: 'await_donation_decision', guestCount: count });
    return await startDonationFlow(phone, contact, event, s);
  }
  db.clearConversation(phone);
  return confirmationMessage(event, s, contact);
}

async function startDonationFlow(phone, contact, event, s) {
  db.saveConversation(phone, { step: 'await_donation_decision', eventId: event.id });
  const menu = buildDonationMenu(event, s);
  return `${personalize(s.donationAsk, contact)}\n\n${menu}`;
}

async function handleDonationDecision(phone, msg, contact, conv, s) {
  const event = db.getEvent(conv.eventId);
  const amount = parseDonation(msg, event);

  if (amount === 'skip') {
    db.clearConversation(phone);
    return confirmationMessage(event, s, contact);
  }

  if (amount === null) {
    const menu = buildDonationMenu(event, s);
    return `I didn't quite catch that. Please reply with a number from the options below or type any amount:\n\n${menu}`;
  }

  // Always use dynamic Stripe Checkout (saves card automatically)
  const { createPaymentLink, getOrCreateCustomer } = require('./payments');
  const customerId = await getOrCreateCustomer(phone, contact?.name);
  const link = await createPaymentLink(amount, event?.name || 'Chabad Event', customerId, phone);

  db.saveRsvp(conv.eventId, phone, { donationAmount: amount });
  db.clearConversation(phone);
  return `${s.donationThankYou}\n🔗 ${link}\n\n${s.cardSavedNote}\n\n${confirmationMessage(event, s, contact)}`;
}

function confirmationMessage(event, s, contact) {
  const first = getFirstName(contact);
  if (!event) return `You're all set${first ? ', ' + first : ''}! See you soon. 🙏`;
  return `You're all set${first ? ', ' + first : ''}! See you at ${event.name} ${event.date} @ ${event.time}. ${s.confirmationNote}`;
}

module.exports = { handleIncoming };
