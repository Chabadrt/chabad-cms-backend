// payments.js — Handles all Stripe interactions.
// Charges cards on file and creates payment links for new donors.

require('dotenv').config();
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── CHARGE A SAVED CARD ───────────────────────────────────
// Used when a returning guest has a card on file.
// stripeCustomerId is saved in our contact database.

async function chargeCardOnFile(stripeCustomerId, amount, eventName) {
  try {
    // Get the customer's default payment method
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    const paymentMethodId = customer.invoice_settings?.default_payment_method;

    if (!paymentMethodId) {
      console.error(`No default payment method for customer ${stripeCustomerId}`);
      return { success: false };
    }

    // Create and confirm a payment intent
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
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
// For new guests without a card on file.
// Creates a Stripe Payment Link they can open in their browser.

async function createPaymentLink(amount, eventName) {
  try {
    // Create a one-time price for this exact amount
    const price = await stripe.prices.create({
      unit_amount: Math.round(amount * 100),
      currency: 'usd',
      product_data: {
        name: `Donation — ${eventName}`,
        metadata: { source: 'sms-rsvp' }
      }
    });

    // Create the payment link
    const link = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      after_completion: {
        type: 'redirect',
        redirect: { url: 'https://chabadrivertowns.com' } // change to your website
      },
      metadata: { event: eventName, source: 'sms-rsvp' }
    });

    console.log(`[STRIPE] Created payment link for $${amount}: ${link.url}`);
    return link.url;

  } catch (err) {
    console.error(`[STRIPE ERROR] createPaymentLink:`, err.message);
    // Fallback to a generic donate link if something goes wrong
    return 'https://chabadrivertowns.com/donate';
  }
}

// ── CREATE OR GET STRIPE CUSTOMER ─────────────────────────
// Called when a new contact donates for the first time.
// Saves their card so future events can use card-on-file.

async function getOrCreateCustomer(phone, name, email = null) {
  try {
    // Check if customer already exists by phone metadata
    const existing = await stripe.customers.search({
      query: `metadata['phone']:'${phone}'`,
      limit: 1
    });

    if (existing.data.length > 0) {
      return existing.data[0].id;
    }

    // Create new customer
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
