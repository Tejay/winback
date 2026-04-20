import Stripe from 'stripe'

/**
 * Spec 23 — Stripe client for Winback's platform account.
 *
 * Distinct from the Connected-account clients used elsewhere (those
 * instantiate with `decrypt(customer.stripeAccessToken)` to act on the
 * customer's Stripe account). This helper uses the platform secret key
 * so we can create customers, setup intents, subscriptions, and invoices
 * on *our* Stripe account for billing the founders.
 *
 * Lazy-constructed inside functions (not at module load) so Vercel build
 * doesn't fail for routes that don't need Stripe when the env var is
 * missing in preview deployments.
 */
export function getPlatformStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
  return new Stripe(key)
}
