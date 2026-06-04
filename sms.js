// sms.js — The brain of the system.
// Handles every incoming text and decides what to reply.

const db = require('./db');
const { chargeCardOnFile, createPaymentLink } = require('./payments');

// ── FUZZY REPLY MATCHING ──────────────────────────────────
// Handles natural language replies so older folks don't get stuck.

function parseYesNo(msg) {
  const m = msg.toLowerCase().trim();
  
  // Clear YES signals
  const yesWords = ['1', 'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 
                    'definitely', 'absolutely', 'of course', 'will be there',
                    'ill be there', "i'll be there", 'coming', "i'll come",
                    'count me in', 'בע"ה', 'im in', "i'm in", 'iy"h',
                    'bezras hashem', "b'ezras hashem", 'iyh', 'be there'];
  
  // Clear NO signals  
  const noWords = ['2', 'no', 'nope', 'cant', "can't", 'cannot', 'sorry',
                   'unfortunately', 'not this time', 'will not', "won't",
                   'unable', 'miss', 'missing', 'not coming', 'skip'];

  for (const word of yesWords) {
    if (m === word || m.includes(word)) return 'yes';
  }
  for (const word of noWords) {
    if (m === word || m.includes(word)) return 'no';
  }
  return null;
}

function parseDonation(msg) {
  const m = msg.toLowerCase().trim();
  
  // Preset amounts
  if (m === '1' || m === '$5' || m === '5') return 5;
  if (m === '2' || m === '$10' || m === '10') return 10;
  if (m === '3' || m === '$18' || m === '18' || m === 'chai' || m === 'חי') return 18;
  
  // Skip signals
  const skipWords = ['n', 'no', 'skip', 'pass', 'next time', 'not now', 'nope'];
  for (const word of skipWords) {
    if (m === word || m.includes(word)) return 'skip';
  }
  
  // Free-form amount
  const cleaned = msg.replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  if (!isNaN(num) && num > 0 && num <= 10000) return Math.round(num * 100) / 100;
  
  return null;
}

function parseConfirm(msg) {
  const m = msg.toLowerCase().trim();
  const yesWords = ['y', 'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'confirm', 'charge it', 'go ahead'];
  const noWords = ['n', 'no', 'nope', 'cancel', 'stop', 'different'];
  for (const word of yesWords) { if (m === word || m.includes(word)) return 'yes'; }
  for (const word of noWords) { if (m === word || m.includes(word)) return 'no'; }
  return null;
}

// ── MAIN HANDLER ──────────────────────────────────────────

async function handleIncoming(from, body) {
  const phone = from.trim();
  const msg = body.trim();
  const conv = db.getConversation(phone);
  const contact = db.getContact(phone);

  console.log(`[SMS IN] ${phone} | step: ${conv.step} | msg: "${msg}"`);

  switch (conv.step) {
    case 'idle':
      return handleIdle(phone, msg, contact, conv);
    case 'await_headcount':
      return handleHeadcount(phone, msg, contact, conv);
    case 'await_donation_decision':
      return handleDonationDecision(phone, msg, contact, conv);
    case 'await_donation_confirm':
      return handleDonationConfirm(phone, msg, contact, conv);
    case 'await_donation_amount':
      return handleDonationAmount(phone, msg, contact, conv);
    default:
      return handleIdle(phone, msg, contact, conv);
  }
}

// ── STEP 1: Initial reply to blast ────────────────────────

async function handleIdle(phone, msg, contact, conv) {
  const event = db.getLatestEvent();
  if (!event) {
    return "Thanks for texting Chabad of the Rivertowns! Stay tuned for upcoming events. 💛\n\nReply STOP to unsubscribe.";
  }

  const answer = parseYesNo(msg);

  if (answer === 'yes') {
    db.saveRsvp(event.id, phone, {
      name: contact?.name || 'Guest',
      status: 'yes'
    });

    if (event.askHeadcount) {
      db.saveConversation(phone, { step: 'await_headcount', eventId: event.id });
      return `Wonderful! How many people will be joining you? (Please reply with just a number, e.g. 2)`;
    } else if (event.askDonation) {
      return await startDonationFlow(phone, contact, event);
    } else {
      db.clearConversation(phone);
      return confirmationMessage(event);
    }
  }

  if (answer === 'no') {
    db.saveRsvp(event.id, phone, {
      name: contact?.name || 'Guest',
      status: 'no'
    });
    db.clearConversation(phone);
    return `No problem! We'll miss you. Hope to see you next time. 💛\n\nReply STOP to unsubscribe.`;
  }

  // Unrecognized — gently re-prompt
  return `Hi! To make sure I get your answer correctly, please reply with just:\n\n1 — Yes, I'll be there 🙏\n2 — Can't make it this time\n\n(This is an automated system — just the number works best! 🤖)`;
}

// ── STEP 2: Headcount ──────────────────────────────────────

async function handleHeadcount(phone, msg, contact, conv) {
  const count = parseInt(msg.replace(/[^0-9]/g, ''));
  if (isNaN(count) || count < 1 || count > 50) {
    return `Please reply with just a number for how many people are joining you (e.g. 2).`;
  }

  const event = db.getEvent(conv.eventId);
  db.saveRsvp(conv.eventId, phone, { guestCount: count });

  if (event?.askDonation) {
    db.saveConversation(phone, { ...conv, step: 'await_donation_decision', guestCount: count });
    return await startDonationFlow(phone, contact, event);
  } else {
    db.clearConversation(phone);
    return confirmationMessage(event);
  }
}

// ── STEP 3: Donation flow ──────────────────────────────────

async function startDonationFlow(phone, contact, event) {
  const hasCard = contact?.cardLast4;
  
  db.saveConversation(phone, {
    step: hasCard ? 'await_donation_decision' : 'await_donation_amount',
    eventId: event.id
  });

  const donationMenu = event.donationAmounts
    ? buildDonationMenu(event.donationAmounts)
    : `1 — $5\n2 — $10\n3 — $18 (Chai ✡️)`;

  if (hasCard) {
    return (
      `💛 Would you like to support this event?\n\n` +
      `${donationMenu}\nN — No thank you\n\n` +
      `You have a card on file ending in ${contact.cardLast4}. ` +
      `Just reply with a number or N.`
    );
  } else {
    return (
      `💛 Would you like to help sponsor the breakfast tomorrow?\n\n` +
      `${donationMenu}\nN — No thank you\n\n` +
      `Reply with a number or N to skip.`
    );
  }
}

function buildDonationMenu(amounts) {
  return amounts.map((amt, i) => {
    const label = amt === 18 ? `$18 (Chai ✡️)` : `$${amt}`;
    return `${i + 1} — ${label}`;
  }).join('\n');
}

async function handleDonationDecision(phone, msg, contact, conv) {
  const event = db.getEvent(conv.eventId);
  const amount = parseDonation(msg);

  if (amount === 'skip' || amount === null && parseYesNo(msg) === 'no') {
    db.clearConversation(phone);
    return confirmationMessage(event);
  }

  if (amount === null) {
    return `Please reply with 1 ($5), 2 ($10), 3 ($18 Chai), or N to skip.`;
  }

  // Has card on file — confirm before charging
  if (contact?.stripeCustomerId && contact?.cardLast4) {
    db.saveConversation(phone, { ...conv, step: 'await_donation_confirm', donationAmount: amount });
    return `Charge $${amount} to your card ending in ${contact.cardLast4}?\n\nReply Y to confirm or N to cancel.`;
  }

  // No card — send payment link
  return await sendPaymentLink(phone, amount, event, conv);
}

async function handleDonationConfirm(phone, msg, contact, conv) {
  const event = db.getEvent(conv.eventId);
  const answer = parseConfirm(msg);

  if (answer === 'no') {
    db.clearConversation(phone);
    return confirmationMessage(event);
  }

  if (answer === 'yes') {
    const result = await chargeCardOnFile(contact.stripeCustomerId, conv.donationAmount, event?.name || 'Chabad Event');
    if (result.success) {
      db.saveRsvp(conv.eventId, phone, { donationAmount: conv.donationAmount, donatedAt: new Date().toISOString() });
      db.clearConversation(phone);
      return `✅ Thank you! Your donation of $${conv.donationAmount} has been processed. ${confirmationMessage(event)}`;
    } else {
      db.clearConversation(phone);
      return `There was an issue processing your card. You can donate at chabadrt.org. ${confirmationMessage(event)}`;
    }
  }

  return `Please reply Y to confirm the charge or N to cancel.`;
}

async function handleDonationAmount(phone, msg, contact, conv) {
  const event = db.getEvent(conv.eventId);
  const amount = parseDonation(msg);

  if (amount === 'skip' || amount === null && parseYesNo(msg) === 'no') {
    db.clearConversation(phone);
    return confirmationMessage(event);
  }

  if (amount === null) {
    return `Please reply with 1 ($5), 2 ($10), 3 ($18 Chai), or N to skip.`;
  }

  return await sendPaymentLink(phone, amount, event, conv);
}

async function sendPaymentLink(phone, amount, event, conv) {
  const link = amount === 5 ? 'https://buy.stripe.com/aFa00j3Jcbj1bwhcPp53O00' :
             amount === 10 ? 'https://buy.stripe.com/00w00j5Rk0En57TbLl53O01' :
             amount === 18 ? 'https://buy.stripe.com/6oU9AT6Vobj17g14iT53O02' :
             'https://buy.stripe.com/aFa00j3Jcbj1bwhcPp53O00';
  db.saveRsvp(conv.eventId, phone, { donationAmount: amount });
  db.clearConversation(phone);
  return (
    `Great! Thank you. Here's your secure payment link for $${amount}:\n🔗 ${link}\n\n` +
    `Your card will be saved for future events — next time it's just one tap! 💛\n\n` +
    confirmationMessage(event)
  );
}

// ── HELPERS ───────────────────────────────────────────────

function confirmationMessage(event) {
  if (!event) return `You're all set! See you soon. 🙏`;
  return `You're all set! See you at ${event.name} on ${event.date} at ${event.time}. ${event.confirmationNote || 'Looking forward to it! 🙏'}`;
}

module.exports = { handleIncoming };
