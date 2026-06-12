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
      description: `Donation — ${eventName} — Chabad of the Rivertowns`,
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

// ── CREATE PAYMENT LINK (permanent, never expires, saves card) ─
// Uses Stripe Payment Links — never expire, reusable, card saved after payment.
async function createPaymentLink(amountDollars, eventName, customerId = null, phone = null) {
  try {
    const stripe = getStripe();
    const baseUrl = process.env.BASE_URL || 'https://chabad-cms-backend-production.up.railway.app';

    // Create a one-time price for this exact amount
    const price = await stripe.prices.create({
      unit_amount: Math.round(amountDollars * 100),
      currency: 'usd',
      product_data: {
        name: `Donation — ${eventName || 'Chabad of the Rivertowns'}`,
        metadata: { source: 'sms-rsvp' }
      }
    });

    // Create permanent Payment Link with card-saving enabled
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      payment_intent_data: {
        setup_future_usage: 'off_session',
        metadata: {
          source: 'sms-rsvp',
          phone: phone || '',
          amount: String(amountDollars),
          event: eventName || ''
        }
      },
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
    });

    console.log(`[STRIPE] Created payment link for $${amountDollars}: ${link.url}`);
    return link.url;

  } catch (err) {
    console.error(`[STRIPE ERROR] createPaymentLink:`, err.message);
    return 'https://chabadrt.org/donate';
  }
}

// ── DONATION CONFIRMATION TEXT ────────────────────────────────
async function getDonationConfirmationText(amountDollars, donorName) {
  const name = donorName ? `, ${donorName}` : '';
  return (
    `🙏 Thank you${name}! Your donation of $${amountDollars} to Chabad of the Rivertowns has been received.\n\n` +
    `Your generosity makes our community thrive. A tax receipt will be emailed to you.\n\n` +
    `— Rabbi Benzion & Hinda Silverman`
  );
}

module.exports = {
  getOrCreateCustomer,
  getSavedCard,
  chargeCardOnFile,
  createPaymentLink,
  getDonationConfirmationText
};
