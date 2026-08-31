// sms.js
const db = require('./db');
const { getSettings } = require('./settings');
const { getOrCreateCustomer, getSavedCard, chargeCardOnFile, createPaymentLink, getReceiptText } = require('./payments');

const DEFAULT_ANNOUNCEMENT_REPLY = 'This is an automated system. To reach the Rabbi please text (914) 330-1307';

function getFirstName(c) { return c?.name ? c.name.split(' ')[0] : null; }
function personalize(t, c) { const f = getFirstName(c); return f ? t.replace(/\{first_name\}/gi, f) : t; }

function parseYesNo(msg) {
  const m = msg.toLowerCase().trim();
  const yes = ['1','yes','yeah','yep','yup','sure','ok','okay','definitely','absolutely','of course','coming','count me in','im in',"i'm in",'iyh','bezras hashem','be there',"i'll be there",'ill be there','will be there'];
  const no = ['2','no','nope','cant',"can't",'cannot','sorry','unfortunately','not this time',"won't",'unable','not coming','skip'];
  for (const w of yes) { if (m === w || m.includes(w)) return 'yes'; }
  for (const w of no) { if (m === w || m.includes(w)) return 'no'; }
  return null;
}

function parseDonation(msg, event) {
  const m = msg.toLowerCase().trim();
  const amounts = event?.donationAmounts || [5, 10, 18];
  const skip = ['n','no','skip','pass','next time','not now','nope','no thank you','no thanks'];
  for (const w of skip) { if (m === w || m.includes(w)) return 'skip'; }
  if (m === '1' && amounts[0]) return amounts[0];
  if (m === '2' && amounts[1]) return amounts[1];
  if (m === '3' && amounts[2]) return amounts[2];
  for (const a of amounts) { if (m === `$${a}` || m === `${a}`) return a; }
  const num = parseFloat(msg.replace(/[$,\s]/g, ''));
  if (!isNaN(num) && num > 0 && num <= 100000) return Math.round(num * 100) / 100;
  return null;
}

function buildDonationMenu(event, s) {
  const amounts = event?.donationAmounts || [5, 10, 18];
  let menu = '';
  amounts.forEach((amt, i) => { menu += `${i+1} — ${amt===18?'$18 (Chai ✡️)':'$'+amt}\n`; });
  if (event?.useFreeform !== false) menu += `Or reply with any amount (e.g. $36)\n`;
  menu += `N — No thank you`;
  return menu;
}

function parseTicketQuantities(msg, tickets) {
  const m = msg.toLowerCase().trim();
  const selections = [];
  for (let i = 0; i < tickets.length; i++) {
    const base = tickets[i].label.toLowerCase().replace(/e?s+$/, '');
    const labelMatch = m.match(new RegExp(`${base}s?`, 'i'));
    if (!labelMatch) continue;
    const labelPos = m.indexOf(labelMatch[0]);
    const afterStr = m.substring(labelPos + labelMatch[0].length, labelPos + labelMatch[0].length + 8);
    const beforeStr = m.substring(Math.max(0, labelPos - 4), labelPos);
    const numAfter = afterStr.match(/^\s*:?\s*(\d+)/);
    const numBefore = beforeStr.match(/(\d+)\s*$/);
    if (numAfter) { const qty = parseInt(numAfter[1]); if (qty > 0) selections.push({ ticketIndex: i, qty }); }
    else if (numBefore) {
      const qty = parseInt(numBefore[1]);
      const alreadyUsed = selections.some(s => { const pp = m.indexOf(tickets[s.ticketIndex].label.toLowerCase()); const tn = m.lastIndexOf(String(qty), labelPos); return Math.abs(pp - tn) < Math.abs(labelPos - tn); });
      if (!alreadyUsed) selections.push({ ticketIndex: i, qty });
    }
  }
  if (selections.length > 0) return selections;
  const nums = m.match(/\d+/g);
  if (nums) { const r = []; for (let i = 0; i < Math.min(nums.length, tickets.length); i++) { const q = parseInt(nums[i]); if (q > 0) r.push({ ticketIndex: i, qty: q }); } if (r.length) return r; }
  return null;
}

function buildTicketMenu(tickets) {
  const lines = tickets.map((t, i) => `${String.fromCharCode(65+i)}) ${t.label} — ${parseFloat(t.price) > 0 ? '$' + t.price : 'Free'}`).join('\n');
  const ex = tickets.length >= 2 ? `"${tickets[0].label} 2 ${tickets[1].label} 1"\nor just numbers: "2 1"` : `"${tickets[0].label} 2" or just "2"`;
  return `${lines}\n\nHow many of each?\n${ex}`;
}

function getEventForPhone(phone) {
  const contact = db.getContact(phone);
  if (contact?.lastEventId) { const e = db.getEvent(contact.lastEventId); if (e) return e; }
  return db.getLatestEvent();
}

function confirmationMessage(event, s) {
  if (!event) return `You're all set! See you soon. 🙏`;
  return `You're all set! See you at ${event.name} ${event.date} @ ${event.time}. ${s.confirmationNote||''}`.trim();
}

async function handleIncoming(from, body) {
  const phone = from.trim(), msg = body.trim();
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
    case 'await_ticket_payment':
    case 'await_donation_after_ticket':
    case 'await_donation_payment':
      return `We're waiting for your payment to be confirmed. If you've already paid, you'll receive a confirmation shortly. Need help? Call (914) 330-1307.`;
    default: return handleIdle(phone, msg, contact, conv, s);
  }
}

async function handleIdle(phone, msg, contact, conv, s) {
  const event = getEventForPhone(phone);
  if (!event) return s.announcementReply || DEFAULT_ANNOUNCEMENT_REPLY;

  // Announcement — one-way message, so any reply gets the automated notice
  if (event.eventType === 'announcement') {
    return s.announcementReply || DEFAULT_ANNOUNCEMENT_REPLY;
  }

  const answer = parseYesNo(msg);
  if (answer === 'yes') {
    db.saveRsvp(event.id, phone, { name: contact?.name || 'Guest', status: 'yes' });
    if (event.askHeadcount) {
      db.saveConversation(phone, { step: 'await_headcount', eventId: event.id });
      return `Wonderful${getFirstName(contact) ? ', ' + getFirstName(contact) : ''}! How many people will be joining you? (Reply with just a number)`;
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
  db.saveRsvp(event?.id || conv.eventId, phone, { guestCount: count });
  return await afterRsvp(phone, contact, event, s, count, { ...conv, eventId: event?.id });
}

async function afterRsvp(phone, contact, event, s, guestCount, conv = {}) {
  if (!event) { db.clearConversation(phone); return `You're all set! 🙏`; }
  const isPaid = event.eventType === 'paid' || event.eventType === 'paid_donation';
  const hasDonation = event.eventType === 'free_donation' || event.eventType === 'paid_donation' || event.askDonation;
  const tickets = event.tickets || [];
  console.log(`[ROUTING] type:${event.eventType} isPaid:${isPaid} hasDonation:${hasDonation} tickets:${tickets.length}`);
  if (isPaid && tickets.length > 0) {
    db.saveConversation(phone, { step: 'await_ticket_quantities', eventId: event.id, guestCount });
    return `Great${getFirstName(contact)?', '+getFirstName(contact):''}! Please choose your tickets:\n\n${buildTicketMenu(tickets)}`;
  }
  if (hasDonation) return await startDonationFlow(phone, contact, event, s, guestCount);
  db.clearConversation(phone);
  return confirmationMessage(event, s);
}

async function handleTicketQuantities(phone, msg, contact, conv, s) {
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const tickets = event?.tickets || [];
  if (!tickets.length) { db.clearConversation(phone); return confirmationMessage(event, s); }
  const selections = parseTicketQuantities(msg, tickets);
  if (!selections) return `I didn't catch that. Please reply with quantities, e.g:\n\n${buildTicketMenu(tickets)}`;
  let total = 0; const summaryLines = [], ticketDesc = [];
  for (const sel of selections) {
    const ticket = tickets[sel.ticketIndex]; if (!ticket) continue;
    const price = parseFloat(ticket.price) || 0;
    const lineTotal = price * sel.qty;
    total += lineTotal;
    summaryLines.push(price > 0 ? `${sel.qty}x ${ticket.label} @ $${price} = $${lineTotal}` : `${sel.qty}x ${ticket.label} — Free`);
    ticketDesc.push(`${sel.qty}x ${ticket.label}`);
  }
  const descStr = ticketDesc.join(', ');
  console.log(`[TICKETS] total:${total} desc:${descStr}`);
  if (!descStr) { db.clearConversation(phone); return `There was a pricing issue. Please call (914) 330-1307.`; }
  const isPaidDonation = event.eventType === 'paid_donation';
  if (total <= 0) {
    // Every ticket selected was free (e.g. kids-only) — no payment needed.
    db.saveRsvp(event.id, phone, { ticketType: descStr, ticketPrice: 0, paymentStatus: 'not_required' });
    db.clearConversation(phone);
    if (isPaidDonation) return await startDonationFlow(phone, contact, event, s);
    return `Here's your order:\n${summaryLines.join('\n')}\n\n${confirmationMessage(event, s)}`;
  }
  db.saveRsvp(event.id, phone, { ticketType: descStr, ticketPrice: total, paymentStatus: 'pending' });
  let customerId = null, savedCard = null;
  try { customerId = await getOrCreateCustomer(phone, contact?.name); savedCard = customerId ? await getSavedCard(customerId) : null; }
  catch (err) { console.error('[TICKET STRIPE]', err.message); }
  const orderSummary = summaryLines.join('\n') + `\n\nTotal: $${total}`;
  if (savedCard) {
    const brandCap = savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1);
    db.saveConversation(phone, { ...conv, step: 'await_card_confirm', pendingAmount: total, pendingLabel: descStr, isTicket: true, isPaidDonation, customerId, savedCard: { paymentMethodId: savedCard.paymentMethodId, brand: savedCard.brand, last4: savedCard.last4 } });
    return `Here's your order:\n${orderSummary}\n\nWe have your ${brandCap} card ending in ${savedCard.last4} on file.\n\n1 — Yes, charge my saved card\n2 — Use a different card`;
  }
  try {
    const link = await createPaymentLink(total, `${event.name} — ${descStr}`, customerId, phone, true);
    db.saveRsvp(event.id, phone, { ticketPaymentLink: link });
    db.saveConversation(phone, { step: isPaidDonation ? 'await_donation_after_ticket' : 'await_ticket_payment', eventId: event.id });
    return `Here's your order:\n${orderSummary}\n\n🎟️ Secure payment link:\n${link}\n\n💳 Your card will be saved for future events.`;
  } catch (err) {
    console.error('[TICKET LINK]', err.message);
    db.clearConversation(phone);
    return `Here's your order:\n${orderSummary}\n\nTo complete payment please call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
  }
}

async function startDonationFlow(phone, contact, event, s, guestCount = null) {
  db.saveConversation(phone, { step: 'await_donation_decision', eventId: event.id, guestCount });
  return `${personalize(s.donationAsk, contact)}\n\n${buildDonationMenu(event, s)}`;
}

async function handleDonationDecision(phone, msg, contact, conv, s) {
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const amount = parseDonation(msg, event);
  if (amount === 'skip') { db.clearConversation(phone); return confirmationMessage(event, s); }
  if (amount === null) return `I didn't catch that.\n\n${buildDonationMenu(event, s)}`;
  console.log(`[DONATION] amount:${amount}`);
  try {
    const customerId = await getOrCreateCustomer(phone, contact?.name);
    const savedCard = customerId ? await getSavedCard(customerId) : null;
    if (savedCard) {
      const brandCap = savedCard.brand.charAt(0).toUpperCase() + savedCard.brand.slice(1);
      db.saveConversation(phone, { ...conv, step: 'await_card_confirm', pendingAmount: amount, isTicket: false, customerId, savedCard: { paymentMethodId: savedCard.paymentMethodId, brand: savedCard.brand, last4: savedCard.last4 } });
      return `We have your ${brandCap} card ending in ${savedCard.last4} on file.\n\nDonate $${amount}?\n\n1 — Yes, charge my saved card\n2 — Use a different card`;
    }
    try {
      const link = await createPaymentLink(amount, event?.name || 'Chabad Event', customerId, phone, true);
      db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: amount });
      db.saveConversation(phone, { step: 'await_donation_payment', eventId: event?.id || conv.eventId, pendingAmount: amount });
      return `${s.donationThankYou || 'Great! Here\'s your secure payment link:'}\n🔗 ${link}\n\n💳 Your card will be saved for next time!`;
    } catch (err) {
      db.clearConversation(phone);
      return `Thank you! To complete your $${amount} donation please visit chabadrt.org or call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
    }
  } catch (err) {
    console.error('[DONATION]', err.message);
    db.clearConversation(phone);
    return `Thank you! To complete your $${amount} donation please call (914) 330-1307.\n\n${confirmationMessage(event, s)}`;
  }
}

async function handleCardConfirm(phone, msg, contact, conv, s) {
  const m = msg.toLowerCase().trim();
  let event = conv.eventId ? db.getEvent(conv.eventId) : null;
  if (!event) event = getEventForPhone(phone);
  const { customerId, savedCard, pendingAmount, isTicket, pendingLabel, isPaidDonation } = conv;
  const isYes = ['1','yes','yeah','yep','sure','ok','y'].includes(m);
  const isNo  = ['2','no','nope','different','new'].includes(m);
  if (isYes) {
    const description = isTicket ? `${event?.name} — ${pendingLabel}` : (event?.name || 'Chabad Event');
    const result = await chargeCardOnFile(customerId, savedCard.paymentMethodId, pendingAmount, description);
    if (result.success) {
      if (isTicket) {
        db.saveRsvp(event?.id || conv.eventId, phone, { paymentStatus: 'paid', chargedOnFile: true });
        const receiptText = await getReceiptText(pendingAmount, getFirstName(contact), 'event', s.receiptMessage || null);
        if (isPaidDonation) { const donMsg = await startDonationFlow(phone, contact, event, s); return `${receiptText}\n\n${donMsg}`; }
        db.clearConversation(phone);
        return `${receiptText}\n\n${confirmationMessage(event, s)}`;
      } else {
        db.saveRsvp(event?.id || conv.eventId, phone, { donationAmount: pendingAmount, chargedOnFile: true });
        db.clearConversation(phone);
        const receiptText = await getReceiptText(pendingAmount, getFirstName(contact), 'donation', s.receiptMessage || null);
        return `${receiptText}\n\n${confirmationMessage(event, s)}`;
      }
    }
    if (result.requiresAction) {
      try { const link = await createPaymentLink(pendingAmount, description, customerId, phone, true); db.clearConversation(phone); return `Your saved card needs re-verification:\n🔗 ${link}`; }
      catch (err) { db.clearConversation(phone); return `There was an issue with your card. Please call (914) 330-1307.`; }
    }
    db.clearConversation(phone);
    return `There was an issue processing your card. Please call (914) 330-1307.`;
  }
  if (isNo) {
    try {
      const desc = isTicket ? `${event?.name} — ${pendingLabel}` : event?.name;
      const link = await createPaymentLink(pendingAmount, desc, customerId, phone, true);
      db.saveConversation(phone, { ...conv, step: isTicket ? (isPaidDonation ? 'await_donation_after_ticket' : 'await_ticket_payment') : 'await_donation_payment' });
      return `Here's your secure payment link:\n🔗 ${link}\n\n💳 Your card will be saved for next time!`;
    } catch (err) { db.clearConversation(phone); return `To complete payment please call (914) 330-1307.`; }
  }
  return `Please reply:\n1 — Yes, charge my saved card\n2 — Use a different card`;
}

module.exports = { handleIncoming };
