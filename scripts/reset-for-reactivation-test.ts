/**
 * Surgical reset for testing the reactivation flow. Cancels the
 * active Stripe subscription, detaches the card, deletes the
 * platform Stripe customer, and clears the billing columns —
 * but KEEPS activated_at, recommended_tier, smoothed_mrr_usd_minor,
 * mrr_snapshots, and recoveries.
 *
 * The resulting state mirrors a real customer who had a subscription,
 * cancelled, and is now revisiting: the banner should fire with the
 * `everSubscribed=true` branch ("Another save just landed.") because
 * there's still a wb_events row for the cancellation.
 *
 *   tsx --env-file=.env.local scripts/reset-for-reactivation-test.ts <email> [--execute]
 */

import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
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
  if (!row) { console.error('no customer for', email); process.exit(1) }

  console.log(`[reset] target: ${email}  (wb_customer ${row.id})`)
  console.log(`[reset] mode:   ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log('')
  console.log('[reset] WILL CLEAR: stripe_platform_customer_id, stripe_subscription_id,')
  console.log('                    billed_tier, billed_changed_at')
  console.log('[reset] WILL KEEP:  activated_at, recommended_tier, smoothed_mrr_usd_minor,')
  console.log('                    mrr_snapshots, recoveries, churned_subscribers')
  console.log('')

  const stripe = getPlatformStripe()

  if (row.stripeSubscriptionId) {
    console.log(`[reset] cancel subscription ${row.stripeSubscriptionId}`)
    if (execute) {
      try {
        await stripe.subscriptions.cancel(row.stripeSubscriptionId)
        console.log('  ok')
      } catch (err) {
        console.warn(`  failed: ${err instanceof Error ? err.message : String(err)}`)
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
      console.log(`[reset] detach payment method ${pm.id} (${pm.card?.brand} *${pm.card?.last4})`)
      if (execute) {
        try { await stripe.paymentMethods.detach(pm.id); console.log('  ok') }
        catch (err) { console.warn(`  failed: ${err instanceof Error ? err.message : String(err)}`) }
      }
    }

    console.log(`[reset] delete platform Stripe customer ${row.stripePlatformCustomerId}`)
    if (execute) {
      try { await stripe.customers.del(row.stripePlatformCustomerId); console.log('  ok') }
      catch (err) { console.warn(`  failed: ${err instanceof Error ? err.message : String(err)}`) }
    }
  }

  console.log('[reset] clear billing columns (preserve tier + activation history)')
  if (execute) {
    const now = new Date()
    await db
      .update(customers)
      .set({
        stripePlatformCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionCreatingAt: null,
        billedTier: null,
        billedChangedAt: now,
        updatedAt: now,
      })
      .where(eq(customers.id, row.id))
    console.log('  ok')
  }

  console.log('')
  console.log(execute
    ? '[reset] done — dashboard banner should now fire on "everSubscribed" branch'
    : '[reset] dry-run only — pass --execute to actually run')
}

main().catch((err) => { console.error('failed', err); process.exit(1) })
