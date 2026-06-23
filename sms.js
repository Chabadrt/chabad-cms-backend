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
// Handles: "Adult 2", "Adults 2", "Adult 2 Child 1", "2 1", "Child 1"
function parseTicketQuantities(msg, tickets) {
  const m = msg.toLowerCase().trim();
  const selections = [];

  for (let i = 0; i < tickets.length; i++) {
    const base = tickets[i].label.toLowerCase().replace(/e?s+$/, '');

    // Find the position of this ticket label in the message
    const labelRe = new RegExp(`${base}\\w*`, 'i');
    const labelMatch = m.match(labelRe);
    if (!labelMatch) continue;

    const labelPos = m.indexOf(labelMatch[0]);
    // Look for a number within 10 chars before or after the label
    const before = m.substring(Math.max(0, labelPos - 5), labelPos);
    const after = m.substring(labelPos + labelMatch[0].length, labelPos + labelMatch[0].length + 10);

    const numAfter = after.match(/^\s*:?\s*(\d+)/);
    const numBefore = before.match(/(\d+)\s*$/);

    if (numAfter) {
      const qty = parseInt(numAfter[1]);
      if (qty > 0) selections.push({ ticketIndex: i, qty });
    } else if (numBefore) {
      const qty = parseInt(numBefore[1]);
      // Make sure this number isn't already used by a previous ticket
      const alreadyUsed = selections.some(s => {
        const prevLabel = tickets[s.ticketIndex].label.toLowerCase();
        const prevPos = m.indexOf(prevLabel);
        const prevNumPos = m.indexOf(String(s.qty));
        const thisNumPos = m.lastIndexOf(String(qty), labelPos);
        return Math.abs(prevPos - thisNumPos) < Math.abs(labelPos - thisNumPos);
      });
      if (!alreadyUsed) selections.push({ ticketIndex: i, qty });
    }
  }

  if (selections.length > 0) return selections;

  // Fallback: pure number sequence — "2 1" = 2 of first, 1 of second
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
  // Build a clear example using actual ticket labels
  let example = '';
  if (tickets.length === 1) {
    example = `e.g. "${tickets[0].label} 2" or just "2"`;
  } else if (tickets.length === 2) {
    example = `e.g. "${tickets[0].label} 2 ${tickets[1].label} 1"\nor just numbers: "2 1"`;
  } else {
    example = `e.g. "${tickets.map((t,i)=>`${t.label} ${i===0?2:1}`).join(' ')}"`;
  }
  return `${lines}\n\nHow many of each?\n${example}`;
}

// ── GET EVENT FOR PHONE ───────────────────────────────────
// Returns the event most recently blasted to this specific phone number.
// This ensures if 2 events were sent, replies go to the right one.
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
    case 'await_save_card':         return handleSaveCardConsent(phone, msg, contact, conv, s);
    case 'await_card_confirm':      return handleCardConfirm(phone, msg, contact, conv, s);
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
  console.log(`[HEADCOUNT] count:${count} eventId:${eventId} eventType:${event?.eventType} tickets:${event?.tickets?.length}`);

  return await afterRsvp(phone, contact, event, s, count, { ...conv, eventId });
}

// ── CENTRAL ROUTING: after RSVP yes (and optional headcount) ──
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

  if (hasDonation) {
    return await startDonationFlow(phone, contact, event, s, guestCount);
  }

  db.clearConversation(phone);
  return confirmationMessage(event, s);
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

  // Build order
  let total = 0;
  const summaryLines = [];
  const ticketDesc = [];
  for (const sel of selections) {
    const ticket = tickets[sel.ticketIndex];
    if (!ticket) continue;
    const price = parseFloat(ticket.price) || 0; // ensure number not string
    const lineTotal = price * sel.qty;
    total += lineTotal;
    summaryLines.push(`${sel.qty}x ${ticket.label} @ $${price} = $${lineTotal}`);
    ticketDesc.push(`${sel.qty}x ${ticket.label}`);
  }
  const descStr = ticketDesc.join(', ');
  console.log(`[TICKETS] selections:${JSON.stringify(selections)} total:${total} desc:${descStr}`);

  if (total <= 0) {
    db.clearConversation(phone);
    return `There was an issue with the ticket pricing. Please call (914) 330-1307 to complete your registration.\n\n${confirmationMessage(event, s)}`;
  }

  db.saveRsvp(event.id, phone, { ticketType: descStr, ticketPrice: total, paymentStatus: 'pending' });

  const customerId = await getOrCreateCustomer(phone, contact?.name).catch(e => { console.error('[TICKET STRIPE]', e.message); return null; });
  const savedCard = customerId ? await getSavedCard(customerId).catch(() => null) : null;
  const orderSummary = summaryLines.join('\n') + `\n\nTotal: $${total}`;

  if (savedCard) {
    const brandCap = savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1);
    db.saveConversation(phone, {
      ...conv, step: 'await_card_confirm',
      pendingAmount: total, pendingLabel: descStr, isTicket: true,
      customerId, savedCard: { paymentMethodId: savedCard.paymentMethodId, brand: savedCard.brand, last4: savedCard.last4 }
    });
    return (
      `Here's your order:\n${orderSummary}\n\n` +
      `We have your ${brandCap} card ending in ${savedCard.last4} on file.\n\n` +
      `1 — Yes, charge my saved card\n2 — Use a different card`
    );
  }

  let link;
  try {
    link = await createPaymentLink(total, `${event.name} — ${descStr}`, customerId, phone, true);
  } catch (err) {
    console.error('[TICKET LINK ERROR]', err.message);
    db.clearConversation(phone);
    return `Here's your order:\n${orderSummary}\n\nTo complete payment, please call (914) 330-1307 or visit chabadrt.org.\n\n${confirmationMessage(event, s)}`;
  }

  db.saveRsvp(event.id, phone, { ticketPaymentLink: link });

  if (event.eventType === 'paid_donation') {
    db.saveConversation(phone, { ...conv, step: 'await_donation_decision', eventId: event.id });
  } else {
    db.clearConversation(phone);
  }

  return (
    `Here's your order:\n${orderSummary}\n\n` +
    `🎟️ Secure ticket link:\n${link}\n\n` +
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
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);

  const amount = parseDonation(msg, event);
  if (amount === 'skip') { db.clearConversation(phone); return confirmationMessage(event, s); }
  if (amount === null) return `I didn't catch that. Please reply with a number or amount:\n\n${buildDonationMenu(event, s)}`;

  console.log(`[DONATION] amount:${amount} phone:${phone}`);

  try {
    const customerId = await getOrCreateCustomer(phone, contact?.name);
    console.log(`[DONATION] customerId:${customerId}`);
    const savedCard = customerId ? await getSavedCard(customerId) : null;
    console.log(`[DONATION] savedCard:${savedCard ? savedCard.last4 : 'none'}`);

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

    db.saveConversation(phone, { ...conv, step: 'await_save_card', pendingAmount: amount, customerId });
    return `Would you like to save your card for next time?\n\n1 — Yes, save my card\n2 — No, just pay now`;

  } catch (err) {
    console.error(`[DONATION ERROR] ${err.message}`);
    // Stripe failed — send payment link without customer tracking
    try {
      const link = await createPaymentLink(amount, event?.name || 'Chabad Event', null, phone, false);
      db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: amount });
      db.clearConversation(phone);
      return `${s.donationThankYou || 'Here\'s your secure payment link:'}\n🔗 ${link}\n\n${confirmationMessage(event, s)}`;
    } catch (linkErr) {
      console.error(`[DONATION LINK ERROR] ${linkErr.message}`);
      db.clearConversation(phone);
      return `Thank you! To complete your donation of $${amount}, please visit chabadrivertowns.com/donate or call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
    }
  }
}

async function handleSaveCardConsent(phone, msg, contact, conv, s) {
  const m = msg.toLowerCase().trim();
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const { pendingAmount, customerId } = conv;

  const isYes = ['1','yes','yeah','yep','sure','ok','okay','y'].includes(m);
  const isNo  = ['2','no','nope','n'].includes(m);
  if (!isYes && !isNo) return `Please reply:\n1 — Yes, save my card\n2 — No, just pay now`;

  db.saveContact(phone, { cardSaveConsent: isYes });
  try {
    const link = await createPaymentLink(pendingAmount, event?.name || 'Chabad Event', customerId, phone, isYes);
    db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: pendingAmount });
    db.clearConversation(phone);
    return (
      `${s.donationThankYou || 'Great! Here\'s your secure payment link:'}\n🔗 ${link}\n` +
      (isYes ? `\n💳 Your card will be saved for next time!\n` : '') +
      `\n${confirmationMessage(event, s)}`
    );
  } catch (err) {
    console.error('[PAYMENT LINK ERROR]', err.message);
    db.clearConversation(phone);
    return `Thank you! To complete your payment of $${pendingAmount}, please visit chabadrivertowns.com/donate or call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
  }
}

async function handleCardConfirm(phone, msg, contact, conv, s) {
  const m = msg.toLowerCase().trim();
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const { customerId, savedCard, pendingAmount, isTicket, pendingLabel } = conv;

  const isYes = ['1','yes','yeah','yep','sure','ok','y'].includes(m);
  const isNo  = ['2','no','nope','different','new'].includes(m);

  if (isYes) {
    const description = isTicket ? `${event?.name} — ${pendingLabel}` : (event?.name || 'Chabad Event');
    const result = await chargeCardOnFile(customerId, savedCard.paymentMethodId, pendingAmount, description);

    if (result.success) {
      if (isTicket) {
        db.saveRsvp(event?.id || conv.eventId, phone, { paymentStatus: 'paid', chargedOnFile: true });
        if (event?.eventType === 'paid_donation') return await startDonationFlow(phone, contact, event, s);
      } else {
        db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: pendingAmount, chargedOnFile: true });
      }
      db.clearConversation(phone);
      const receiptType = isTicket ? 'event' : (s.receiptType || 'donation');
      const receiptText = await getReceiptText(pendingAmount, getFirstName(contact), receiptType, s.receiptMessage || null);
      return `${receiptText}\n\n${confirmationMessage(event, s)}`;
    }

    if (result.requiresAction) {
      const link = await createPaymentLink(pendingAmount, description, customerId, phone, true);
      db.clearConversation(phone);
      return `Your saved card needs re-verification:\n🔗 ${link}\n\n${confirmationMessage(event, s)}`;
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
