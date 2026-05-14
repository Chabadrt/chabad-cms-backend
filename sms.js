// sms.js — The brain of the system.
// Handles every incoming text and decides what to reply.

const db = require('./db');
const { chargeCardOnFile, createPaymentLink } = require('./payments');

// ── MAIN HANDLER ──────────────────────────────────────────
// Called by server.js every time someone texts your Twilio number.

async function handleIncoming(from, body) {
  const phone = from.trim();
  const msg = body.trim();
  const conv = db.getConversation(phone);
  const contact = db.getContact(phone);

  console.log(`[SMS IN] ${phone} | step: ${conv.step} | msg: "${msg}"`);

  // Route based on conversation state
  switch (conv.step) {
    case 'idle':
      return handleIdle(phone, msg, contact, conv);
    case 'await_headcount':
      return handleHeadcount(phone, msg, contact, conv);
    case 'await_donation_decision':
      return handleDonationDecision(phone, msg, contact, conv);
    case 'await_donation_amount':
      return handleDonationAmount(phone, msg, contact, conv);
    case 'await_new_card':
      return handleNewCard(phone, msg, contact, conv);
    default:
      return handleIdle(phone, msg, contact, conv);
  }
}

// ── STEP 1: Initial reply to blast (1 = yes, 2 = no) ─────

async function handleIdle(phone, msg, contact, conv) {
  const event = db.getLatestEvent();
  if (!event) return "Thanks for texting Chabad of the Rivertowns! Stay tuned for upcoming events. 💛";

  if (msg === '1') {
    // Save RSVP as yes
    db.saveRsvp(event.id, phone, {
      name: contact?.name || 'Guest',
      status: 'yes'
    });

    if (event.askHeadcount) {
      db.saveConversation(phone, { step: 'await_headcount', eventId: event.id });
      return `Wonderful! How many people will be joining you? (Reply with a number)`;
    } else if (event.askDonation) {
      return await startDonationFlow(phone, contact, event);
    } else {
      db.clearConversation(phone);
      return confirmationMessage(event);
    }
  }

  if (msg === '2') {
    db.saveRsvp(event.id, phone, {
      name: contact?.name || 'Guest',
      status: 'no'
    });
    db.clearConversation(phone);
    return `No problem! We'll miss you. We'll keep you in the loop for future events. 💛`;
  }

  // Unrecognized — gently re-prompt
  return `Hi! Reply 1 to RSVP for our ${event.name} on ${event.date}, or 2 if you can't make it.`;
}

// ── STEP 2: Headcount ──────────────────────────────────────

async function handleHeadcount(phone, msg, contact, conv) {
  const count = parseInt(msg);
  if (isNaN(count) || count < 1 || count > 50) {
    return `Please reply with a number (e.g. 2) for how many people are joining you.`;
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

// ── STEP 3: Donation decision ──────────────────────────────

async function startDonationFlow(phone, contact, event) {
  if (contact?.cardLast4) {
    // Returning guest with card on file
    db.saveConversation(phone, {
      step: 'await_donation_decision',
      eventId: event.id
    });
    return (
      `💛 Would you like to support tonight's event?\n\n` +
      `You have a card on file ending in ${contact.cardLast4}. ` +
      `Reply with an amount (e.g. $36) to donate, or N to skip.`
    );
  } else {
    // New guest — offer link
    db.saveConversation(phone, {
      step: 'await_donation_amount',
      eventId: event.id
    });
    return (
      `💛 Would you like to make a donation to support this event?\n\n` +
      `Reply with an amount (e.g. $36) and we'll send you a secure link, or reply N to skip.`
    );
  }
}

async function handleDonationDecision(phone, msg, contact, conv) {
  const upper = msg.toUpperCase();
  const event = db.getEvent(conv.eventId);

  if (upper === 'N' || upper === 'NO') {
    db.clearConversation(phone);
    return confirmationMessage(event);
  }

  // Try to parse a dollar amount
  const amount = parseDollarAmount(msg);
  if (!amount) {
    return `Please reply with an amount (e.g. $36) or N to skip.`;
  }

  // Charge card on file
  if (contact?.stripeCustomerId) {
    const result = await chargeCardOnFile(contact.stripeCustomerId, amount, event?.name || 'Chabad Event');
    if (result.success) {
      db.saveRsvp(conv.eventId, phone, { donationAmount: amount, donatedAt: new Date().toISOString() });
      db.clearConversation(phone);
      return (
        `✅ Thank you! Your donation of $${amount} has been processed. ` +
        confirmationMessage(event)
      );
    } else {
      return `There was an issue processing your card. Reply with a different amount or N to skip.`;
    }
  }

  // Fallback to payment link
  const link = await createPaymentLink(amount, event?.name || 'Chabad Event');
  db.saveRsvp(conv.eventId, phone, { donationAmount: amount });
  db.clearConversation(phone);
  return `Here's your secure payment link:\n🔗 ${link}\n\nThank you so much! 🙏\n\n` + confirmationMessage(event);
}

async function handleDonationAmount(phone, msg, contact, conv) {
  const upper = msg.toUpperCase();
  const event = db.getEvent(conv.eventId);

  if (upper === 'N' || upper === 'NO') {
    db.clearConversation(phone);
    return confirmationMessage(event);
  }

  const amount = parseDollarAmount(msg);
  if (!amount) {
    return `Please reply with an amount (e.g. $36) or N to skip.`;
  }

  const link = await createPaymentLink(amount, event?.name || 'Chabad Event');
  db.saveRsvp(conv.eventId, phone, { donationAmount: amount });
  db.clearConversation(phone);
  return `Here's your secure payment link:\n🔗 ${link}\n\nThank you for your generosity! 🙏\n\n` + confirmationMessage(event);
}

async function handleNewCard(phone, msg, contact, conv) {
  // Placeholder — card entry happens via Stripe link, not SMS
  db.clearConversation(phone);
  return `Got it! Check your link to complete your donation. Thank you! 💛`;
}

// ── HELPERS ───────────────────────────────────────────────

function parseDollarAmount(str) {
  const cleaned = str.replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0 || num > 10000) return null;
  return Math.round(num * 100) / 100; // round to cents
}

function confirmationMessage(event) {
  if (!event) return `You're all set! See you soon. Chag Sameach! 🌸`;
  return `✅ You're all set! See you at the ${event.name} on ${event.date} at ${event.time}. Chag Sameach! 🌸`;
}

module.exports = { handleIncoming };
