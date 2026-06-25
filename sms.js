// sms.js — Conversation flow brain
const db = require('./db');
const { getSettings } = require('./settings');
const {
  getOrCreateCustomer,
  getSavedCard,
  chargeCardOnFile,
  createPaymentLink,
  getReceiptText
} = require('./payments');

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
  const skipWords = ['n','no','skip','pass','next time','not now','nope','no thank you','no thanks'];
  for (const w of skipWords) { if (m === w || m.includes(w)) return 'skip'; }
  if (m === '1' && amounts[0]) return amounts[0];
  if (m === '2' && amounts[1]) return amounts[1];
  if (m === '3' && amounts[2]) return amounts[2];
  for (const amt of amounts) {
    if (m === `$${amt}` || m === `${amt}`) return amt;
  }
  const cleaned = msg.replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  if (!isNaN(num) && num > 0 && num <= 100000) return Math.round(num * 100) / 100;
  return null;
}

function buildDonationMenu(event, s) {
  const amounts = event?.donationAmounts || [5, 10, 18];
  const useFreeform = event?.useFreeform !== false;
  let menu = '';
  if (amounts.length > 0) {
    amounts.forEach((amt, i) => {
      const label = amt === 18 ? `$18 (Chai ✡️)` : `$${amt}`;
      menu += `${i + 1} — ${label}\n`;
    });
  }
  if (useFreeform) menu += `Or reply with any amount (e.g. $36)\n`;
  menu += `N — No thank you`;
  return menu;
}

// ── TICKET QUANTITY PARSER ────────────────────────────────
function parseTicketQuantities(msg, tickets) {
  const m = msg.toLowerCase().trim();
  const selections = [];

  for (let i = 0; i < tickets.length; i++) {
    const base = tickets[i].label.toLowerCase().replace(/e?s+$/, '');
    const labelRe = new RegExp(`${base}s?`, 'i');
    const labelMatch = m.match(labelRe);
    if (!labelMatch) continue;
    const labelPos = m.indexOf(labelMatch[0]);
    const labelEnd = labelPos + labelMatch[0].length;
    const afterStr = m.substring(labelEnd, labelEnd + 8);
    const beforeStr = m.substring(Math.max(0, labelPos - 4), labelPos);
    const numAfter = afterStr.match(/^\s*:?\s*(\d+)/);
    const numBefore = beforeStr.match(/(\d+)\s*$/);
    if (numAfter) {
      const qty = parseInt(numAfter[1]);
      if (qty > 0) selections.push({ ticketIndex: i, qty });
    } else if (numBefore) {
      const qty = parseInt(numBefore[1]);
      const alreadyUsed = selections.some(s => {
        const prevLabel = tickets[s.ticketIndex].label.toLowerCase();
        const prevPos = m.indexOf(prevLabel);
        const thisNumPos = m.lastIndexOf(String(qty), labelPos);
        return Math.abs(prevPos - thisNumPos) < Math.abs(labelPos - thisNumPos);
      });
      if (!alreadyUsed) selections.push({ ticketIndex: i, qty });
    }
  }

  if (selections.length > 0) return selections;

  // Fallback: pure number sequence
  const nums = m.match(/\d+/g);
  if (nums && nums.length >= 1) {
    const result = [];
    for (let i = 0; i < Math.min(nums.length, tickets.length); i++) {
      const qty = parseInt(nums[i]);
      if (qty > 0) result.push({ ticketIndex: i, qty });
    }
    if (result.length > 0) return result;
  }
  return null;
}

function buildTicketMenu(tickets) {
  const lines = tickets.map((t, i) => `${String.fromCharCode(65 + i)}) ${t.label} — $${t.price}`).join('\n');
  const example = tickets.length >= 2
    ? `"${tickets[0].label} 2 ${tickets[1].label} 1"\nor just numbers: "2 1"`
    : `"${tickets[0].label} 2" or just "2"`;
  return `${lines}\n\nHow many of each?\n${example}`;
}

// ── GET EVENT FOR PHONE ───────────────────────────────────
// Returns the event most recently blasted to this specific phone
function getEventForPhone(phone) {
  const contact = db.getContact(phone);
  if (contact?.lastEventId) {
    const event = db.getEvent(contact.lastEventId);
    if (event) return event;
  }
  return db.getLatestEvent();
}

async function handleIncoming(from, body) {
  const phone = from.trim();
  const msg = body.trim();
  const conv = db.getConversation(phone);
  const contact = db.getContact(phone);
  const s = getSettings();
  console.log(`[SMS IN] ${phone} | step:${conv.step} | msg:"${msg}"`);

  switch (conv.step) {
    case 'idle':                    return handleIdle(phone, msg, contact, conv, s);
    case 'await_headcount':         return handleHeadcount(phone, msg, contact, conv, s);
    case 'await_ticket_quantities': return handleTicketQuantities(phone, msg, contact, conv, s);
    case 'await_donation_decision': return handleDonationDecision(phone, msg, contact, conv, s);
    case 'await_card_confirm':      return handleCardConfirm(phone, msg, contact, conv, s);
    // These states are waiting for Stripe webhook — don't process inbound SMS
    case 'await_ticket_payment':
    case 'await_donation_after_ticket':
    case 'await_donation_payment':
      return `We're waiting for your payment to be confirmed. If you've already paid, you'll receive a confirmation shortly. Need help? Call (914) 330-1307.`;
    default:                        return handleIdle(phone, msg, contact, conv, s);
  }
}

async function handleIdle(phone, msg, contact, conv, s) {
  const event = getEventForPhone(phone);
  if (!event) return `Thanks for texting Chabad of the Rivertowns! Stay tuned for upcoming events. 💛\n\nReply STOP to unsubscribe.`;

  const answer = parseYesNo(msg);

  if (answer === 'yes') {
    db.saveRsvp(event.id, phone, { name: contact?.name || 'Guest', status: 'yes' });
    if (event.askHeadcount) {
      db.saveConversation(phone, { step: 'await_headcount', eventId: event.id });
      const first = getFirstName(contact);
      return `Wonderful${first ? ', ' + first : ''}! How many people will be joining you? (Reply with just a number)`;
    }
    return await afterRsvp(phone, contact, event, s, null);
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
  if (isNaN(count) || count < 1 || count > 100) return `Please reply with just a number (e.g. 2).`;
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const eventId = event?.id || conv.eventId;
  db.saveRsvp(eventId, phone, { guestCount: count });
  console.log(`[HEADCOUNT] count:${count} eventId:${eventId} eventType:${event?.eventType}`);
  return await afterRsvp(phone, contact, event, s, count, { ...conv, eventId });
}

// ── CENTRAL ROUTING AFTER RSVP YES ───────────────────────
async function afterRsvp(phone, contact, event, s, guestCount, conv = {}) {
  if (!event) { db.clearConversation(phone); return `You're all set! See you soon. 🙏`; }
  const isPaid = event.eventType === 'paid' || event.eventType === 'paid_donation';
  const hasDonation = event.eventType === 'free_donation' || event.eventType === 'paid_donation' || event.askDonation;
  const tickets = event.tickets || [];
  console.log(`[ROUTING] eventType:${event.eventType} isPaid:${isPaid} hasDonation:${hasDonation} tickets:${tickets.length}`);

  if (isPaid && tickets.length > 0) {
    db.saveConversation(phone, { step: 'await_ticket_quantities', eventId: event.id, guestCount });
    const first = getFirstName(contact);
    return `Great${first ? ', ' + first : ''}! Please choose your tickets:\n\n${buildTicketMenu(tickets)}`;
  }

  if (hasDonation) return await startDonationFlow(phone, contact, event, s, guestCount);

  db.clearConversation(phone);
  return `You're all set! See you at ${event.name} ${event.date} @ ${event.time}. ${s.confirmationNote || ''}`.trim();
}

// ── TICKET QUANTITIES ─────────────────────────────────────
async function handleTicketQuantities(phone, msg, contact, conv, s) {
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const tickets = event?.tickets || [];

  if (!tickets.length) { db.clearConversation(phone); return confirmationMessage(event, s); }

  const selections = parseTicketQuantities(msg, tickets);
  if (!selections) {
    return `I didn't catch that. Please reply with quantities, e.g:\n\n${buildTicketMenu(tickets)}`;
  }

  // Build order summary
  let total = 0;
  const summaryLines = [];
  const ticketDesc = [];
  for (const sel of selections) {
    const ticket = tickets[sel.ticketIndex];
    if (!ticket) continue;
    const price = parseFloat(ticket.price) || 0;
    const lineTotal = price * sel.qty;
    total += lineTotal;
    summaryLines.push(`${sel.qty}x ${ticket.label} @ $${price} = $${lineTotal}`);
    ticketDesc.push(`${sel.qty}x ${ticket.label}`);
  }
  const descStr = ticketDesc.join(', ');
  console.log(`[TICKETS] total:${total} desc:${descStr}`);

  if (total <= 0) {
    db.clearConversation(phone);
    return `There was a pricing issue. Please call (914) 330-1307 to complete your registration.`;
  }

  db.saveRsvp(event.id, phone, { ticketType: descStr, ticketPrice: total, paymentStatus: 'pending' });

  // Check for saved card
  let customerId = null;
  let savedCard = null;
  try {
    customerId = await getOrCreateCustomer(phone, contact?.name);
    savedCard = customerId ? await getSavedCard(customerId) : null;
  } catch (err) {
    console.error('[TICKET STRIPE CUSTOMER]', err.message);
  }

  const orderSummary = summaryLines.join('\n') + `\n\nTotal: $${total}`;
  const isPaidDonation = event.eventType === 'paid_donation';

  if (savedCard) {
    const brandCap = savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1);
    db.saveConversation(phone, {
      ...conv, step: 'await_card_confirm',
      pendingAmount: total, pendingLabel: descStr, isTicket: true,
      isPaidDonation,
      customerId, savedCard: { paymentMethodId: savedCard.paymentMethodId, brand: savedCard.brand, last4: savedCard.last4 }
    });
    return (
      `Here's your order:\n${orderSummary}\n\n` +
      `We have your ${brandCap} card ending in ${savedCard.last4} on file.\n\n` +
      `1 — Yes, charge my saved card\n2 — Use a different card`
    );
  }

  // No saved card — create payment link (always save card for tickets)
  try {
    const link = await createPaymentLink(total, `${event.name} — ${descStr}`, customerId, phone, true);
    db.saveRsvp(event.id, phone, { ticketPaymentLink: link });

    // ── CHANGE 2 & 4 ──────────────────────────────────────
    // For paid_donation: save state so webhook can trigger donation after payment
    // "You're all set" is NOT sent here — it will be sent by webhook after payment confirmed
    if (isPaidDonation) {
      db.saveConversation(phone, { step: 'await_donation_after_ticket', eventId: event.id });
    } else {
      // For paid-only: webhook sends confirmation, so clear conversation now
      db.saveConversation(phone, { step: 'await_ticket_payment', eventId: event.id });
    }

    return (
      `Here's your order:\n${orderSummary}\n\n` +
      `🎟️ Secure payment link:\n${link}\n\n` +
      `💳 Your card will be saved for future events.`
      // Note: NO "You're all set" here — webhook sends it after payment
    );
  } catch (err) {
    console.error('[TICKET LINK ERROR]', err.message);
    db.clearConversation(phone);
    return `Here's your order:\n${orderSummary}\n\nTo complete payment please call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
  }
}

// ── DONATION FLOW ─────────────────────────────────────────
async function startDonationFlow(phone, contact, event, s, guestCount = null) {
  db.saveConversation(phone, { step: 'await_donation_decision', eventId: event.id, guestCount });
  const menu = buildDonationMenu(event, s);
  return `${personalize(s.donationAsk, contact)}\n\n${menu}`;
}

async function handleDonationDecision(phone, msg, contact, conv, s) {
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);

  const amount = parseDonation(msg, event);
  if (amount === 'skip') {
    db.clearConversation(phone);
    return confirmationMessage(event, s);
  }
  if (amount === null) return `I didn't catch that. Please reply with a number or amount:\n\n${buildDonationMenu(event, s)}`;

  console.log(`[DONATION] amount:${amount} phone:${phone}`);

  try {
    const customerId = await getOrCreateCustomer(phone, contact?.name);
    const savedCard = customerId ? await getSavedCard(customerId) : null;

    if (savedCard) {
      const brandCap = savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1);
      db.saveConversation(phone, {
        ...conv, step: 'await_card_confirm',
        pendingAmount: amount, isTicket: false,
        customerId, savedCard: { paymentMethodId: savedCard.paymentMethodId, brand: savedCard.brand, last4: savedCard.last4 }
      });
      return (
        `We have your ${brandCap} card ending in ${savedCard.last4} on file.\n\nDonate $${amount}?\n\n` +
        `1 — Yes, charge my saved card\n2 — Use a different card`
      );
    }

    // ── CHANGE 1 ─────────────────────────────────────────
    // No "save card" question — always save automatically
    try {
      const link = await createPaymentLink(amount, event?.name || 'Chabad Event', customerId, phone, true);
      db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: amount });
      // Save state so webhook can send confirmation after payment
      db.saveConversation(phone, { step: 'await_donation_payment', eventId: event?.id || conv.eventId, pendingAmount: amount });
      return (
        `${s.donationThankYou || 'Great! Here\'s your secure payment link:'}\n🔗 ${link}\n\n` +
        `💳 Your card will be saved for next time!`
        // Note: NO "You're all set" here — webhook sends it after payment
      );
    } catch (err) {
      console.error('[DONATION LINK ERROR]', err.message);
      db.clearConversation(phone);
      return `Thank you! To complete your $${amount} donation please visit chabadrt.org or call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
    }

  } catch (err) {
    console.error('[DONATION ERROR]', err.message);
    try {
      const link = await createPaymentLink(amount, event?.name || 'Chabad Event', null, phone, true);
      db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: amount });
      db.saveConversation(phone, { step: 'await_donation_payment', eventId: event?.id || conv.eventId, pendingAmount: amount });
      return `${s.donationThankYou || 'Here\'s your secure payment link:'}\n🔗 ${link}`;
    } catch (linkErr) {
      db.clearConversation(phone);
      return `Thank you! To complete your $${amount} donation please call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
    }
  }
}

// ── CARD ON FILE CONFIRM ──────────────────────────────────
async function handleCardConfirm(phone, msg, contact, conv, s) {
  const m = msg.toLowerCase().trim();
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const { customerId, savedCard, pendingAmount, isTicket, pendingLabel, isPaidDonation } = conv;

  const isYes = ['1','yes','yeah','yep','sure','ok','y'].includes(m);
  const isNo  = ['2','no','nope','different','new'].includes(m);

  if (isYes) {
    const description = isTicket ? `${event?.name} — ${pendingLabel}` : (event?.name || 'Chabad Event');
    const result = await chargeCardOnFile(customerId, savedCard.paymentMethodId, pendingAmount, description, phone);

    if (result.success) {
      if (isTicket) {
        db.saveRsvp(event?.id || conv.eventId, phone, { paymentStatus: 'paid', chargedOnFile: true });
        // ── CHANGE 3 ─────────────────────────────────────
        // Send ticket receipt immediately since no webhook for card-on-file
        const receiptText = await getReceiptText(pendingAmount, getFirstName(contact), 'event', s.receiptMessage || null);

        if (isPaidDonation) {
          // Proceed to donation after ticket receipt
          const donationMsg = await startDonationFlow(phone, contact, event, s);
          return `${receiptText}\n\n${donationMsg}`;
        } else {
          db.clearConversation(phone);
          return `${receiptText}\n\n${confirmationMessage(event, s)}`;
        }
      } else {
        // Donation paid via card on file
        db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: pendingAmount, chargedOnFile: true });
        db.clearConversation(phone);
        const receiptText = await getReceiptText(pendingAmount, getFirstName(contact), 'donation', s.receiptMessage || null);
        return `${receiptText}\n\n${confirmationMessage(event, s)}`;
      }
    }

    if (result.requiresAction) {
      try {
        const link = await createPaymentLink(pendingAmount, description, customerId, phone, true);
        db.clearConversation(phone);
        return `Your saved card needs re-verification:\n🔗 ${link}`;
      } catch (err) {
        db.clearConversation(phone);
        return `There was an issue with your card. Please call (914) 330-1307.`;
      }
    }

    db.clearConversation(phone);
    return `There was an issue processing your card. Please call (914) 330-1307.`;
  }

  if (isNo) {
    // Use a different card — create new payment link (no "save card" question)
    try {
      const link = await createPaymentLink(pendingAmount, isTicket ? `${event?.name} — ${pendingLabel}` : event?.name, customerId, phone, true);
      if (isTicket) {
        db.saveConversation(phone, { ...conv, step: isPaidDonation ? 'await_donation_after_ticket' : 'await_ticket_payment' });
      } else {
        db.saveConversation(phone, { ...conv, step: 'await_donation_payment' });
      }
      return `Here's your secure payment link:\n🔗 ${link}\n\n💳 Your card will be saved for next time!`;
    } catch (err) {
      db.clearConversation(phone);
      return `To complete payment please call (914) 330-1307.`;
    }
  }

  return `Please reply:\n1 — Yes, charge my saved card\n2 — Use a different card`;
}

function confirmationMessage(event, s) {
  if (!event) return `You're all set! See you soon. 🙏`;
  return `You're all set! See you at ${event.name} ${event.date} @ ${event.time}. ${s.confirmationNote || ''}`.trim();
}

module.exports = { handleIncoming };
