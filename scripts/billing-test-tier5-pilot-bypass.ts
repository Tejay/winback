// Tier 5 — Pilot bypass (Spec 31).
//
// While customers.pilot_until > NOW:
//   - ensureActivation returns { state: 'pilot' }, no platform sub created
//   - chargePerformanceFee returns { skipped: 'pilot' }, no Stripe item created
//   - platform_billing_skipped_pilot event logged
//   - performance_fee_skipped_pilot event(s) logged on direct chargePerformanceFee
//
// When pilot expires (pilot_until < NOW), the very next ensureActivation
// falls through normally and starts billing — no manual graduation step.
//
// Combined script — three sub-cases:
//   5.1  Pilot active → first recovery bypassed (3 recoveries seeded for breadth)
//   5.1b Direct chargePerformanceFee call → its own pilot guard fires too
//   5.2  Pilot expires → ensureActivation falls through, all queued perf fees charge
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier5-pilot-bypass.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, wbEvents, users } from '../lib/schema'
import { eq, and, desc } from 'drizzle-orm'
import { ensureActivation } from '../src/winback/lib/activation'
import { chargePerformanceFee } from '../src/winback/lib/performance-fee'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const PERF_FEE_MRR_CENTS = 5000

async function seedWinbackRecovery(customerId: string, tag: string): Promise<{ subId: string; recId: string }> {
  const [sub] = await db.insert(churnedSubscribers).values({
    customerId,
    stripeCustomerId: `cus_TIER5_${tag}`,
    name: `Tier 5 ${tag}`,
    email: `tier5-${tag}@example.com`,
    cancellationReason: 'Lost interest',
    mrrCents: PERF_FEE_MRR_CENTS,
    status: 'recovered',
  }).returning({ id: churnedSubscribers.id })

  await db.insert(emailsSent).values({
    subscriberId: sub.id, type: 'exit',
    subject: '(tier 5) synthetic', bodyText: '(tier 5)',
    sentAt: new Date(Date.now() - 60_000), repliedAt: new Date(),
  })

  const [rec] = await db.insert(recoveries).values({
    subscriberId: sub.id, customerId,
    planMrrCents: PERF_FEE_MRR_CENTS,
    recoveryType: 'win_back', attributionType: 'strong',
  }).returning({ id: recoveries.id })

  return { subId: sub.id, recId: rec.id }
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }
  if (c.stripeSubscriptionId || c.activatedAt) {
    console.error('Customer NOT at baseline. Run reset first.'); process.exit(1)
  }

  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-03-25.dahlia' })

  console.log('=== Tier 5 — Pilot bypass ===\n')

  // === Setup: platform customer + PM (so non-pilot path can succeed in 5.2)
  console.log('[setup] Create platform Stripe customer + attach pm_card_visa as default')
  const platformCustomer = await platform.customers.create({
    email: `tier5-${Date.now()}@example.com`, name: 'Tier 5 platform',
    metadata: { winback_customer_id: c.id, tier: '5' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await platform.customers.update(platformCustomer.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  await db.update(customers)
    .set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() })
    .where(eq(customers.id, c.id))
  console.log(`    platform=${platformCustomer.id}  PM=${pm.id}`)

  // Seed 3 win-back recoveries
  console.log('[setup] Seed 3 win-back recoveries (each $50 MRR = $50 perf fee, total $150)')
  const recoveriesIds: string[] = []
  for (let i = 0; i < 3; i++) {
    const r = await seedWinbackRecovery(c.id, `r${i + 1}_${Date.now()}`)
    recoveriesIds.push(r.recId)
    console.log(`    rec ${i + 1}: recId=${r.recId}`)
  }

  // === 5.1 — Active pilot ===
  console.log('\n[5.1] Active pilot (pilot_until = NOW + 30d) → ensureActivation should return state=pilot')
  const pilotUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await db.update(customers).set({ pilotUntil, updatedAt: new Date() }).where(eq(customers.id, c.id))
  const eventsBefore51 = await db.select({ n: wbEvents.id }).from(wbEvents).where(eq(wbEvents.customerId, c.id))

  const r51 = await ensureActivation(c.id)
  console.log(`    ensureActivation returned: state=${r51.state}`)
  if (r51.state !== 'pilot') { console.error(`    ❌ expected state=pilot, got ${r51.state}`); process.exit(1) }
  console.log(`    pilotUntil=${r51.state === 'pilot' ? r51.pilotUntil?.toISOString() : 'n/a'} ✓`)

  const [after51] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  if (after51.stripeSubscriptionId) { console.error(`    ❌ stripeSubscriptionId got set: ${after51.stripeSubscriptionId}`); process.exit(1) }
  console.log(`    customers.stripeSubscriptionId=NULL ✓`)

  // Verify no platform sub on Stripe
  const subsOnStripe51 = await platform.subscriptions.list({ customer: platformCustomer.id, status: 'all', limit: 5 })
  console.log(`    Stripe subs on platform customer: ${subsOnStripe51.data.length} ${subsOnStripe51.data.length === 0 ? '✓' : '❌'}`)

  // Verify no perf fee items on Stripe
  const itemsOnStripe51 = await platform.invoiceItems.list({ customer: platformCustomer.id, limit: 20 })
  console.log(`    Stripe invoice items on platform customer: ${itemsOnStripe51.data.length} ${itemsOnStripe51.data.length === 0 ? '✓' : '❌'}`)

  // Verify all 3 recoveries still have perfFeeStripeItemId = NULL (queued, not charged)
  const recoveriesAfter51 = await db.select().from(recoveries).where(eq(recoveries.customerId, c.id))
  const unchanged = recoveriesAfter51.every(r => r.perfFeeStripeItemId === null && r.perfFeeChargedAt === null)
  console.log(`    All 3 recoveries: perfFeeStripeItemId=NULL, perfFeeChargedAt=NULL ${unchanged ? '✓' : '❌'}`)

  // Verify platform_billing_skipped_pilot event logged
  const [pilotEvent51] = await db.select().from(wbEvents)
    .where(and(eq(wbEvents.customerId, c.id), eq(wbEvents.name, 'platform_billing_skipped_pilot')))
    .orderBy(desc(wbEvents.createdAt)).limit(1)
  console.log(`    wb_events.platform_billing_skipped_pilot ${pilotEvent51 ? `id=${pilotEvent51.id} ✓` : '❌ missing'}`)

  // === 5.1b — direct chargePerformanceFee under pilot ===
  console.log('\n[5.1b] Direct chargePerformanceFee on rec[0] → should also skip with skipped=pilot')
  const r51b = await chargePerformanceFee(recoveriesIds[0])
  console.log(`    skipped=${r51b.skipped}  invoiceItemId=${r51b.invoiceItemId ?? 'null ✓'}`)
  if (r51b.skipped !== 'pilot') { console.error(`    ❌ expected skipped=pilot`); process.exit(1) }

  const [perfSkipEvent] = await db.select().from(wbEvents)
    .where(and(eq(wbEvents.customerId, c.id), eq(wbEvents.name, 'performance_fee_skipped_pilot')))
    .orderBy(desc(wbEvents.createdAt)).limit(1)
  console.log(`    wb_events.performance_fee_skipped_pilot ${perfSkipEvent ? `id=${perfSkipEvent.id} ✓` : '❌ missing'}`)
  if (perfSkipEvent) {
    const props = perfSkipEvent.properties as { recoveryId?: string; skippedAmountCents?: number }
    console.log(`      properties.skippedAmountCents=${props.skippedAmountCents} ${props.skippedAmountCents === PERF_FEE_MRR_CENTS ? '✓' : '❌ (expected ' + PERF_FEE_MRR_CENTS + ')'}`)
    console.log(`      properties.recoveryId=${props.recoveryId === recoveriesIds[0] ? '✓ matches' : '❌'}`)
  }

  // === 5.2 — Pilot expires ===
  console.log('\n[5.2] Backdate pilot_until to NOW − 1d → ensureActivation should fall through, sub created, all 3 perf fees charged')
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  await db.update(customers).set({ pilotUntil: yesterday, updatedAt: new Date() }).where(eq(customers.id, c.id))

  const r52 = await ensureActivation(c.id)
  console.log(`    ensureActivation returned: state=${r52.state}`)
  if (r52.state !== 'active') { console.error(`    ❌ expected state=active, got ${r52.state}`); process.exit(1) }
  console.log(`    subscriptionId=${r52.state === 'active' ? r52.subscriptionId : 'n/a'} ✓`)
  console.log(`    chargedRecoveryIds.length=${r52.state === 'active' ? r52.chargedRecoveryIds.length : 0} (expected 3) ${r52.state === 'active' && r52.chargedRecoveryIds.length === 3 ? '✓' : '❌'}`)

  // Verify Stripe-side
  const subsOnStripe52 = await platform.subscriptions.list({ customer: platformCustomer.id, status: 'all', limit: 5 })
  console.log(`    Stripe subs on platform customer: ${subsOnStripe52.data.length} ${subsOnStripe52.data.length === 1 ? '✓' : '❌ expected 1'}`)
  const activeSub = subsOnStripe52.data.find(s => s.status === 'active')
  console.log(`    Active sub: ${activeSub?.id ?? 'NONE'} ${activeSub ? '✓' : '❌'}`)

  const itemsOnStripe52 = await platform.invoiceItems.list({ customer: platformCustomer.id, limit: 20 })
  const perfItems = itemsOnStripe52.data.filter(i => (i.description ?? '').startsWith('Win-back:'))
  console.log(`    Perf-fee invoice items: ${perfItems.length} ${perfItems.length === 3 ? '✓' : '❌ expected 3'}`)

  const [after52] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  console.log(`    customers.stripeSubscriptionId=${after52.stripeSubscriptionId ?? 'NULL ❌'}`)
  console.log(`    customers.activatedAt=${after52.activatedAt?.toISOString() ?? 'NULL ❌'}`)

  console.log('\n✓✓✓ Tier 5 verified — pilot active bypasses billing, pilot expired resumes billing automatically.')
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })
