const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const FEE_PCT = Number(process.env.STRIPE_PLATFORM_FEE_PERCENT || 10) / 100;

// Hold payment (authorize but don't capture) — escrow
async function createEscrow(amountUSD, customerId, jobId, providerStripeAccountId) {
  const amountCents = Math.round(amountUSD * 100);
  const feeCents = Math.round(amountCents * FEE_PCT);

  const intent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: 'usd',
    customer: customerId,
    capture_method: 'manual',  // authorize only — don't charge yet
    metadata: { jobId, platform_fee_cents: feeCents },
    transfer_data: providerStripeAccountId
      ? { destination: providerStripeAccountId }
      : undefined,
    application_fee_amount: providerStripeAccountId ? feeCents : undefined,
    description: `Roady job ${jobId}`,
  });

  return {
    clientSecret: intent.client_secret,
    paymentIntentId: intent.id,
    platformFeeCents: feeCents,
    providerAmountCents: amountCents - feeCents,
  };
}

// Release escrow after job completion — captures the hold
async function capturePayment(paymentIntentId) {
  return stripe.paymentIntents.capture(paymentIntentId);
}

// Cancel escrow (no charge to customer)
async function cancelPayment(paymentIntentId) {
  return stripe.paymentIntents.cancel(paymentIntentId);
}

// Refund after capture (dispute resolution)
async function refundPayment(paymentIntentId, amountCents) {
  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: amountCents,
  });
}

// Create or retrieve Stripe Connect account for provider payouts
async function createConnectAccount(email, providerName) {
  return stripe.accounts.create({
    type: 'express',
    email,
    business_type: 'individual',
    business_profile: { name: providerName },
    capabilities: { transfers: { requested: true } },
  });
}

// Generate onboarding link for provider to add bank account
async function connectOnboardingLink(accountId, returnUrl, refreshUrl) {
  return stripe.accountLinks.create({
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
}

// Construct event from Stripe webhook payload
function constructWebhookEvent(payload, signature) {
  return stripe.webhooks.constructEvent(
    payload,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

module.exports = {
  stripe,
  createEscrow,
  capturePayment,
  cancelPayment,
  refundPayment,
  createConnectAccount,
  connectOnboardingLink,
  constructWebhookEvent,
};
