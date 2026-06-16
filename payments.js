// payments.js — Handles all Stripe interactions.

const Stripe = require('stripe');

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

// ── GET OR CREATE STRIPE CUSTOMER ────────────────────────────
async function getOrCreateCustomer(phone, name, email = null) {
  try {
    const stripe = getStripe();
    const existing = await stripe.customers.search({
      query: `metadata['phone']:'${phone}'`,
      limit: 1
    });
    if (existing.data.length > 0) {
      console.log(`[STRIPE] Found existing customer for ${phone}`);
      return existing.data[0].id;
    }
    const customer = await stripe.customers.create({
      name: name || 'Chabad Guest',
      phone,
      ...(email ? { email } : {}),
      metadata: { phone, source: 'sms-rsvp' }
    });
    console.log(`[STRIPE] Created customer ${customer.id} for ${phone}`);
    return customer.id;
  } catch (err) {
    console.error(`[STRIPE ERROR] getOrCreateCustomer:`, err.message);
    return null;
  }
}

// ── CHECK FOR SAVED CARD ──────────────────────────────────────
async function getSavedCard(customerId) {
  try {
    if (!customerId) return null;
    const stripe = getStripe();
    const methods = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1
    });
    if (methods.data.length > 0) {
      const card = methods.data[0].card;
      return {
        paymentMethodId: methods.data[0].id,
        brand: card.brand,
        last4: card.last4,
        expMonth: card.exp_month,
        expYear: card.exp_year
      };
    }
    return null;
  } catch (err) {
    console.error(`[STRIPE ERROR] getSavedCard:`, err.message);
    return null;
  }
}

// ── CHARGE SAVED CARD ─────────────────────────────────────────
async function chargeCardOnFile(customerId, paymentMethodId, amountDollars, eventName) {
  try {
    const stripe = getStripe();
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amountDollars * 100),
      currency: 'usd',
      customer: customerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      description: `Payment — ${eventName} — Chabad of the Rivertowns`,
      metadata: { event: eventName, source: 'sms-rsvp-card-on-file' }
    });
    if (intent.status === 'succeeded') {
      console.log(`[STRIPE] Charged $${amountDollars} for ${eventName} | intent: ${intent.id}`);
      return { success: true, intentId: intent.id };
    }
    return { success: false, error: `Payment status: ${intent.status}` };
  } catch (err) {
    console.error(`[STRIPE ERROR] chargeCardOnFile:`, err.message);
    return { success: false, error: err.message, requiresAction: true };
  }
}

// ── CREATE PAYMENT LINK (permanent, never expires) ────────────
// saveCard: true = includes setup_future_usage so card is saved after payment
async function createPaymentLink(amountDollars, eventName, customerId = null, phone = null, saveCard = true) {
  try {
    const stripe = getStripe();
    const baseUrl = process.env.BASE_URL || 'https://chabad-cms-backend-production.up.railway.app';

    const price = await stripe.prices.create({
      unit_amount: Math.round(amountDollars * 100),
      currency: 'usd',
      product_data: {
        name: `${eventName || 'Chabad of the Rivertowns'}`,
        metadata: { source: 'sms-rsvp' }
      }
    });

    const linkParams = {
      line_items: [{ price: price.id, quantity: 1 }],
      after_completion: {
        type: 'redirect',
        redirect: {
          url: `${baseUrl}/donation-success?amount=${amountDollars}&phone=${encodeURIComponent(phone || '')}`
        }
      },
      metadata: {
        phone: phone || '',
        amount: String(amountDollars),
        event: eventName || ''
      }
    };

    // Only add setup_future_usage if user consented to saving card
    if (saveCard) {
      linkParams.payment_intent_data = {
        setup_future_usage: 'off_session',
        metadata: {
          source: 'sms-rsvp',
          phone: phone || '',
          amount: String(amountDollars),
          event: eventName || ''
        }
      };
    } else {
      linkParams.payment_intent_data = {
        metadata: {
          source: 'sms-rsvp',
          phone: phone || '',
          amount: String(amountDollars),
          event: eventName || ''
        }
      };
    }

    const link = await stripe.paymentLinks.create(linkParams);
    console.log(`[STRIPE] Created payment link for $${amountDollars} (saveCard:${saveCard}): ${link.url}`);
    return link.url;

  } catch (err) {
    console.error(`[STRIPE ERROR] createPaymentLink:`, err.message);
    return 'https://chabadrt.org/donate';
  }
}

// ── RECEIPT CONFIRMATION TEXT ─────────────────────────────────
// receiptType: 'donation' | 'event'
// customMessage: editable from Settings tab
async function getReceiptText(amountDollars, donorName, receiptType, customMessage) {
  const name = donorName ? `, ${donorName}` : '';
  const closing = `\n\n— Rabbi Benjy & Hinda Silverman`;

  // Use custom message from settings if provided
  if (customMessage) {
    return customMessage
      .replace('{name}', donorName || '')
      .replace('{amount}', `$${amountDollars}`)
      + closing;
  }

  if (receiptType === 'event') {
    return (
      `❤️ Got it${name}! Your payment of $${amountDollars} has been received.\n\n` +
      `We're looking forward to seeing you!` +
      closing
    );
  }

  // Default: donation
  return (
    `❤️ Thank you${name}! Your donation of $${amountDollars} to Chabad of the Rivertowns has been received.\n\n` +
    `Your generosity makes our community thrive.` +
    closing
  );
}

module.exports = {
  getOrCreateCustomer,
  getSavedCard,
  chargeCardOnFile,
  createPaymentLink,
  getReceiptText
};
