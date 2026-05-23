/**
 * One-shot tier-Price provisioner. Calls the production `tierPriceId`
 * helper for Starter / Growth / Scale on the platform Stripe account,
 * which will:
 *   - reuse the env-var Price ID if set, else
 *   - reuse the existing Price by lookup_key if found, else
 *   - create the Product + Price.
 *
 * Prints the resulting Price IDs so you can paste them into .env.local
 * (STRIPE_PRICE_ID_STARTER / GROWTH / SCALE). Re-running is idempotent —
 * the helper short-circuits when a Price already exists.
 *
 *   tsx --env-file=.env.local scripts/provision-tier-prices-once.ts
 */

import { getPlatformStripe } from '../src/winback/lib/platform-stripe'
import { tierPriceId } from '../src/winback/lib/tiers'
import type { TierKey } from '../src/winback/lib/tiers'

const TIERS: ReadonlyArray<TierKey> = ['starter', 'growth', 'scale']

async function main(): Promise<void> {
  const stripe = getPlatformStripe()

  console.log('[provision-tier-prices] resolving tier Prices on platform Stripe')
  console.log('[provision-tier-prices] mode:', (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_live_') ? 'LIVE' : 'TEST')
  console.log('')

  for (const tier of TIERS) {
    const envKey = `STRIPE_PRICE_ID_${tier.toUpperCase()}`
    const fromEnv = process.env[envKey]
    const resolved = await tierPriceId(stripe, tier)
    const source =
      fromEnv === resolved
        ? 'env-var'
        : '(auto-created or lookup_key match)'
    console.log(`  ${tier.padEnd(8)} ${resolved}  ${source}`)
    console.log(`    ${envKey}=${resolved}`)
  }

  console.log('')
  console.log('[provision-tier-prices] done. Paste the lines above into .env.local')
  console.log('[provision-tier-prices] if you want them pinned by env var instead of resolved lookup_key.')
}

main().catch((err) => {
  console.error('[provision-tier-prices] failed', err)
  process.exit(1)
})
