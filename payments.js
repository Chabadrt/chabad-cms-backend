// payments.js — Handles all Stripe interactions.
// Charges cards on file and creates payment links for new donors.

const Stripe = require('stripe');

// Lazy load — only initializes when a payment function is actually called
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

// ── CHARGE A SAVED CARD ───────────────────────────────────

async function chargeCardOnFile(stripeCustomerId, amount, eventName) {
  try {
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const paymentMethodId = customer.invoice_settings?.default_payment_method;

    if (!paymentMethodId) {
      console.error(`No default payment method for customer ${stripeCustomerId}`);
      return { success: false };
    }

    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      customer: stripeCustomerId,
      payment_method: paymentMethodId,
      confirm: true,
      off_session: true,
      description: `Donation — ${eventName} — Chabad of the Rivertowns`,
      metadata: { event: eventName, source: 'sms-rsvp' }
    });

    console.log(`[STRIPE] Charged $${amount} for ${eventName} | intent: ${intent.id}`);
    return { success: true, intentId: intent.id };

  } catch (err) {
    console.error(`[STRIPE ERROR] chargeCardOnFile:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── CREATE A PAYMENT LINK ─────────────────────────────────

async function createPaymentLink(amount, eventName) {
  try {
    const stripe = getStripe();

    const price = await stripe.prices.create({
      unit_amount: Math.round(amount * 100),
      currency: 'usd',
      product_data: {
        name: `Donation — ${eventName}`,
        metadata: { source: 'sms-rsvp' }
      }
    });

    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      after_completion: {
        type: 'redirect',
        redirect: { url: 'https://chabadrivertowns.com' }
      },
      metadata: { event: eventName, source: 'sms-rsvp' }
    });

    console.log(`[STRIPE] Created payment link for $${amount}: ${link.url}`);
    return link.url;

  } catch (err) {
    console.error(`[STRIPE ERROR] createPaymentLink:`, err.message);
    return 'https://chabadrivertowns.com/donate';
  }
}

// ── CREATE OR GET STRIPE CUSTOMER ─────────────────────────

async function getOrCreateCustomer(phone, name, email = null) {
  try {
    const stripe = getStripe();

    const existing = await stripe.customers.search({
      query: `metadata['phone']:'${phone}'`,
      limit: 1
    });

    if (existing.data.length > 0) {
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

module.exports = { chargeCardOnFile, createPaymentLink, getOrCreateCustomer };
