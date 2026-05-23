/**
 * DESTRUCTIVE: wipes all billing/payment state for a customer to reset
 * them to a "freshly-OAuth'd, never billed" state. Used for the
 * activation-flow end-to-end test.
 *
 * Stripe (platform account):
 *   - cancels the active subscription immediately (no period-end wait)
 *   - detaches all card payment methods
 *   - deletes the platform Stripe customer
 *
 * Our DB:
 *   - clears stripe_platform_customer_id, stripe_subscription_id,
 *     activated_at, recommended_tier, billed_tier, smoothed_mrr_*,
 *     recommended_changed_at, billed_changed_at, requires_sales
 *   - resets cumulative_revenue_saved_cents to 0
 *   - deletes all wb_mrr_snapshots rows for this customer
 *
 * Pass --execute to actually run; without it, dry-run prints what would
 * happen.
 *
 *   tsx --env-file=.env.local scripts/wipe-billing-for-test.ts <email> [--execute]
 */

import { db } from '@/lib/db'
import { customers, users, mrrSnapshots } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from '../src/winback/lib/platform-stripe'

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'tejaasvi@gmail.com'
  const execute = process.argv.includes('--execute')

  const [row] = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      stripeSubscriptionId: customers.stripeSubscriptionId,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(users.email, email))
    .limit(1)
  if (!row) {
    console.error('no customer for', email)
    process.exit(1)
  }

  console.log(`[wipe] target: ${email}  (wb_customer ${row.id})`)
  console.log(`[wipe] mode:   ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log('')

  const stripe = getPlatformStripe()

  // 1. Cancel + detach Stripe-side artifacts
  if (row.stripeSubscriptionId) {
    console.log(`[wipe] cancel subscription ${row.stripeSubscriptionId}`)
    if (execute) {
      try {
        await stripe.subscriptions.cancel(row.stripeSubscriptionId)
        console.log(`  ok`)
      } catch (err) {
        console.warn(`  failed (probably already gone): ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  if (row.stripePlatformCustomerId) {
    const pms = await stripe.paymentMethods.list({
      customer: row.stripePlatformCustomerId,
      type: 'card',
      limit: 50,
    })
    for (const pm of pms.data) {
      console.log(`[wipe] detach payment method ${pm.id} (${pm.card?.brand} *${pm.card?.last4})`)
      if (execute) {
        try {
          await stripe.paymentMethods.detach(pm.id)
          console.log(`  ok`)
        } catch (err) {
          console.warn(`  failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
    console.log(`[wipe] delete platform Stripe customer ${row.stripePlatformCustomerId}`)
    if (execute) {
      try {
        await stripe.customers.del(row.stripePlatformCustomerId)
        console.log(`  ok`)
      } catch (err) {
        console.warn(`  failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // 2. Wipe DB rows
  const now = new Date()
  console.log('[wipe] clear wb_customers billing columns + reset cumulative_revenue_saved_cents')
  if (execute) {
    await db
      .update(customers)
      .set({
        stripePlatformCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionCreatingAt: null,
        activatedAt: null,
        recommendedTier: null,
        billedTier: null,
        smoothedMrrUsdMinor: null,
        smoothedMrrComputedAt: null,
        recommendedChangedAt: null,
        billedChangedAt: null,
        requiresSales: false,
        cumulativeRevenueSavedCents: 0,
        cumulativeRevenueLastComputedAt: null,
        updatedAt: now,
      })
      .where(eq(customers.id, row.id))
    console.log('  ok')
  }

  console.log('[wipe] delete wb_mrr_snapshots for this customer')
  if (execute) {
    const deleted = await db
      .delete(mrrSnapshots)
      .where(eq(mrrSnapshots.customerId, row.id))
      .returning({ id: mrrSnapshots.id })
    console.log(`  deleted ${deleted.length} rows`)
  }

  console.log('')
  console.log(execute ? '[wipe] done' : '[wipe] dry-run only — pass --execute to actually run')
}

main().catch((err) => { console.error('failed', err); process.exit(1) })
