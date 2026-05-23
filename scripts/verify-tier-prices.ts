/**
 * Verifies the 3 platform tier Prices have the expected amounts +
 * recurring intervals. Read-only sanity check.
 *
 *   tsx --env-file=.env.local scripts/verify-tier-prices.ts
 */

import { getPlatformStripe } from '../src/winback/lib/platform-stripe'
import { tierPriceId, type TierKey } from '../src/winback/lib/tiers'
import { tierConfig } from '../src/winback/lib/billing-config'

const TIERS: ReadonlyArray<TierKey> = ['starter', 'growth', 'scale']

async function main(): Promise<void> {
  const stripe = getPlatformStripe()
  let allOk = true

  for (const tier of TIERS) {
    const cfg = tierConfig(tier)
    const id = await tierPriceId(stripe, tier)
    const price = await stripe.prices.retrieve(id, { expand: ['product'] })
    const product = price.product as { name: string }
    const expectedAmount = cfg.priceUsdMinor!
    const actualAmount = price.unit_amount
    const intervalOk =
      price.recurring?.interval === 'month' &&
      (price.recurring?.interval_count ?? 1) === 1
    const amountOk = actualAmount === expectedAmount
    const lookupOk = price.lookup_key === cfg.lookupKey
    const status = amountOk && intervalOk && lookupOk ? '✓' : '✗'
    if (!(amountOk && intervalOk && lookupOk)) allOk = false
    console.log(
      `${status} ${tier.padEnd(8)} ${id}  ${product.name}  ` +
        `$${(actualAmount! / 100).toFixed(2)}/${price.recurring?.interval}  ` +
        `lookup_key=${price.lookup_key}`,
    )
    if (!amountOk) {
      console.error(`    expected $${(expectedAmount / 100).toFixed(2)}`)
    }
  }
  if (!allOk) process.exit(1)
}

main().catch((err) => {
  console.error('failed', err)
  process.exit(1)
})
