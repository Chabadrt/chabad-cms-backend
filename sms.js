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
// Parses replies like "2 adults 1 child", "1 adult 2 children", "2 1", "adult 2 child 1"
// Returns array of { ticketIndex, qty } or null if unparseable
function parseTicketQuantities(msg, tickets) {
  const m = msg.toLowerCase().trim();

  // Try matching ticket labels with quantities
  const selections = [];
  let matched = false;

  for (let i = 0; i < tickets.length; i++) {
    const label = tickets[i].label.toLowerCase();
    // Try "2 adults", "adults 2", "2 adult"
    const patterns = [
      new RegExp(`(\\d+)\\s+${label.replace(/s$/,'')}s?`),
      new RegExp(`${label.replace(/s$/,'')}s?\\s+(\\d+)`),
    ];
    for (const re of patterns) {
      const match = m.match(re);
      if (match) {
        selections.push({ ticketIndex: i, qty: parseInt(match[1]) });
        matched = true;
        break;
      }
    }
  }

  if (matched && selections.length > 0) return selections;

  // Try pure number sequence: "2 1" means 2 of ticket[0], 1 of ticket[1]
  const nums = m.match(/\d+/g);
  if (nums && nums.length >= 1 && nums.length <= tickets.length) {
    const result = [];
    for (let i = 0; i < nums.length; i++) {
      const qty = parseInt(nums[i]);
      if (qty > 0) result.push({ ticketIndex: i, qty });
    }
    if (result.length > 0) return result;
  }

  return null;
}

function buildTicketQuantityMenu(tickets) {
  let menu = tickets.map((t, i) => `${String.fromCharCode(65 + i)}) ${t.label} — $${t.price}`).join('\n');
  menu += '\n\nReply with quantities, e.g:';
  if (tickets.length === 2) {
    menu += `\n"2 ${tickets[0].label} 1 ${tickets[1].label}"`;
    menu += `\nor just numbers: "2 1"`;
  } else {
    menu += `\n"1 ${tickets[0].label}"`;
  }
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
    case 'idle':                    return handleIdle(phone, msg, contact, conv, s);
    case 'await_headcount':         return handleHeadcount(phone, msg, contact, conv, s);
    case 'await_ticket_quantities': return handleTicketQuantities(phone, msg, contact, conv, s);
    case 'await_donation_decision': return handleDonationDecision(phone, msg, contact, conv, s);
    case 'await_save_card':         return handleSaveCardConsent(phone, msg, contact, conv, s);
    case 'await_card_confirm':      return handleCardConfirm(phone, msg, contact, conv, s);
    default:                        return handleIdle(phone, msg, contact, conv, s);
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
    }

    return await afterHeadcount(phone, contact, event, s, null);
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
  // Use getEvent first, fall back to getLatestEvent if missing
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = db.getLatestEvent();
  const eventId = event?.id || conv.eventId;
  db.saveRsvp(eventId, phone, { guestCount: count });
  console.log(`[HEADCOUNT] eventType: ${event?.eventType}, tickets: ${JSON.stringify(event?.tickets)}`);
  return await afterHeadcount(phone, contact, event, s, count, { ...conv, eventId });
}

// ── CENTRAL ROUTING AFTER HEADCOUNT ──────────────────────
async function afterHeadcount(phone, contact, event, s, guestCount, conv = {}) {
  // Safety: if event is missing, try to get it
  if (!event) event = conv.eventId ? db.getEvent(conv.eventId) : db.getLatestEvent();
  if (!event) { db.clearConversation(phone); return `You're all set! See you soon. 🙏`; }

  const isPaid = event?.eventType === 'paid' || event?.eventType === 'paid_donation';
  const hasDonation = event?.eventType === 'free_donation' || event?.eventType === 'paid_donation' || event?.askDonation;
  const tickets = event?.tickets || [];

  console.log(`[ROUTING] eventType:${event.eventType} isPaid:${isPaid} hasDonation:${hasDonation} tickets:${tickets.length}`);

  if (isPaid && tickets.length > 0) {
    db.saveConversation(phone, { step: 'await_ticket_quantities', eventId: event.id, guestCount });
    const first = getFirstName(contact);
    const menu = buildTicketQuantityMenu(tickets);
    return `Great${first ? ', ' + first : ''}! Please choose your tickets:\n\n${menu}`;
  }

  if (hasDonation) {
    return await startDonationFlow(phone, contact, event, s, guestCount);
  }

  db.clearConversation(phone);
  return confirmationMessage(event, s);
}

// ── TICKET QUANTITY HANDLER ───────────────────────────────
async function handleTicketQuantities(phone, msg, contact, conv, s) {
  const event = db.getEvent(conv.eventId);
  const tickets = event?.tickets || [];

  const selections = parseTicketQuantities(msg, tickets);

  if (!selections) {
    return `I didn't quite catch that. Please reply with ticket quantities, e.g:\n\n${buildTicketQuantityMenu(tickets)}`;
  }

  // Build order summary and total
  let total = 0;
  let summary = [];
  for (const sel of selections) {
    const ticket = tickets[sel.ticketIndex];
    if (!ticket) continue;
    const lineTotal = ticket.price * sel.qty;
    total += lineTotal;
    summary.push(`${sel.qty}x ${ticket.label} ($${ticket.price} each) = $${lineTotal}`);
    // Save each ticket type to RSVP
    db.saveRsvp(conv.eventId, phone, {
      ticketType: selections.map(s => `${s.qty}x ${tickets[s.ticketIndex]?.label}`).join(', '),
      ticketPrice: total,
      paymentStatus: 'pending'
    });
  }

  const summaryText = summary.join('\n');

  // Get or create Stripe customer — always save card for paid events
  const customerId = await getOrCreateCustomer(phone, contact?.name);
  const savedCard = customerId ? await getSavedCard(customerId) : null;

  const ticketDesc = selections.map(sel => `${sel.qty}x ${tickets[sel.ticketIndex]?.label}`).join(', ');

  if (savedCard) {
    const brandCap = savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1);
    db.saveConversation(phone, {
      ...conv,
      step: 'await_card_confirm',
      pendingAmount: total,
      pendingLabel: ticketDesc,
      isTicket: true,
      customerId,
      savedCard: { paymentMethodId: savedCard.paymentMethodId, brand: savedCard.brand, last4: savedCard.last4 }
    });
    return (
      `Here's your order:\n${summaryText}\n\nTotal: $${total}\n\n` +
      `We have your ${brandCap} card ending in ${savedCard.last4} on file.\n\n` +
      `1 — Yes, charge my saved card\n` +
      `2 — Use a different card`
    );
  }

  // No saved card — send payment link
  const link = await createPaymentLink(total, `${event.name} — ${ticketDesc}`, customerId, phone, true);
  db.saveRsvp(conv.eventId, phone, { ticketPaymentLink: link });

  // After ticket — check if donation should follow
  const hasDonation = event?.eventType === 'paid_donation';
  if (hasDonation) {
    db.saveConversation(phone, { ...conv, step: 'await_donation_decision', eventId: event.id });
  } else {
    db.clearConversation(phone);
  }

  return (
    `Here's your order:\n${summaryText}\n\nTotal: $${total}\n\n` +
    `Here's your secure ticket link:\n🎟️ ${link}\n\n` +
    `💳 Your card will be saved for future events.\n\n` +
    confirmationMessage(event, s)
  );
}

// ── DONATION FLOW ─────────────────────────────────────────
async function startDonationFlow(phone, contact, event, s, guestCount = null) {
  db.saveConversation(phone, { step: 'await_donation_decision', eventId: event.id, guestCount });
  const menu = buildDonationMenu(event, s);
  return `${personalize(s.donationAsk, contact)}\n\n${menu}`;
}

async function handleDonationDecision(phone, msg, contact, conv, s) {
  const event = db.getEvent(conv.eventId);
  const amount = parseDonation(msg, event);

  if (amount === 'skip') {
    db.clearConversation(phone);
    return confirmationMessage(event, s);
  }

  if (amount === null) {
    return `I didn't quite catch that. Please reply with a number or type any amount:\n\n${buildDonationMenu(event, s)}`;
  }

  const customerId = await getOrCreateCustomer(phone, contact?.name);
  const savedCard = customerId ? await getSavedCard(customerId) : null;

  if (savedCard) {
    const brandCap = savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1);
    db.saveConversation(phone, {
      ...conv,
      step: 'await_card_confirm',
      pendingAmount: amount,
      isTicket: false,
      customerId,
      savedCard: { paymentMethodId: savedCard.paymentMethodId, brand: savedCard.brand, last4: savedCard.last4 }
    });
    return (
      `We have your ${brandCap} card ending in ${savedCard.last4} on file.\n\n` +
      `Donate $${amount}?\n\n` +
      `1 — Yes, charge my saved card\n` +
      `2 — Use a different card`
    );
  }

  db.saveConversation(phone, { ...conv, step: 'await_save_card', pendingAmount: amount, customerId });
  return `Would you like to save your card for next time?\n\n1 — Yes, save my card\n2 — No, just pay now`;
}

async function handleSaveCardConsent(phone, msg, contact, conv, s) {
  const m = msg.toLowerCase().trim();
  const event = db.getEvent(conv.eventId);
  const { pendingAmount, customerId } = conv;

  const isYes = ['1','yes','yeah','yep','sure','ok','okay','y'].includes(m);
  const isNo  = ['2','no','nope','n'].includes(m);
  if (!isYes && !isNo) return `Please reply:\n1 — Yes, save my card\n2 — No, just pay now`;

  db.saveContact(phone, { cardSaveConsent: isYes });
  const link = await createPaymentLink(pendingAmount, event?.name || 'Chabad Event', customerId, phone, isYes);
  db.saveRsvp(conv.eventId, phone, { donationAmount: pendingAmount });
  db.clearConversation(phone);

  return (
    `${s.donationThankYou || 'Great! Here\'s your secure payment link:'}\n🔗 ${link}\n` +
    (isYes ? `\n💳 Your card will be saved for next time!\n` : '') +
    `\n${confirmationMessage(event, s)}`
  );
}

async function handleCardConfirm(phone, msg, contact, conv, s) {
  const m = msg.toLowerCase().trim();
  const event = db.getEvent(conv.eventId);
  const { customerId, savedCard, pendingAmount, isTicket, pendingLabel } = conv;

  const isYes = ['1','yes','yeah','yep','sure','ok','y'].includes(m);
  const isNo  = ['2','no','nope','different','new'].includes(m);

  if (isYes) {
    const description = isTicket
      ? `${event?.name} — ${pendingLabel}`
      : event?.name || 'Chabad Event';
    const result = await chargeCardOnFile(customerId, savedCard.paymentMethodId, pendingAmount, description);

    if (result.success) {
      if (isTicket) {
        db.saveRsvp(conv.eventId, phone, { paymentStatus: 'paid', chargedOnFile: true });
        // If paid_donation, trigger donation ask after ticket payment
        if (event?.eventType === 'paid_donation') {
          return await startDonationFlow(phone, contact, event, s);
        }
      } else {
        db.saveRsvp(conv.eventId, phone, { donationAmount: pendingAmount, chargedOnFile: true });
      }
      db.clearConversation(phone);
      const receiptType = isTicket ? 'event' : (s.receiptType || 'donation');
      const receiptText = await getReceiptText(pendingAmount, getFirstName(contact), receiptType, s.receiptMessage || null);
      return `${receiptText}\n\n${confirmationMessage(event, s)}`;
    }

    if (result.requiresAction) {
      const link = await createPaymentLink(pendingAmount, description, customerId, phone, true);
      db.clearConversation(phone);
      return `Your saved card needs re-verification. Please use this link:\n🔗 ${link}\n\n${confirmationMessage(event, s)}`;
    }

    db.clearConversation(phone);
    return `There was an issue processing your card. Please call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
  }

  if (isNo) {
    db.saveConversation(phone, { ...conv, step: 'await_save_card' });
    return `No problem! Would you like to save your new card for next time?\n\n1 — Yes, save it\n2 — No thanks`;
  }

  return `Please reply:\n1 — Yes, charge my saved card\n2 — Use a different card`;
}

function confirmationMessage(event, s) {
  if (!event) return `You're all set! See you soon. 🙏`;
  return `You're all set! See you at ${event.name} ${event.date} @ ${event.time}. ${s.confirmationNote || ''}`.trim();
}

module.exports = { handleIncoming };
