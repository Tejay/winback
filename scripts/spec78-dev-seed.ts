// Spec 78 — dev-only seed for local clicking-around.
//
// Idempotent. Run against your local .env.local (which points at your
// Neon dev DB and uses your existing tejaasvi@gmail.com merchant row).
//
// Adds:
//   • Two promotion-kind wb_improvements rows (WINBACK25 + COMEBACK50)
//     so /reasons shows the Promotions section non-empty
//   • One product-kind wb_improvements row so the Improvements card
//     also has a row (if your account doesn't already have one)
//   • Two synthetic wb_churned_subscribers + wb_recoveries pairs:
//       - Acme Corp: win-back recovery with applied_promotion_code_id
//         set → dashboard chip renders ("WINBACK25 · −25% × 3mo")
//       - StoryFlow: win-back recovery with applied COMEBACK50 promo
//
// Run:
//   npx tsx --env-file=.env.local scripts/spec78-dev-seed.ts
//
// To wipe the seeded rows later:
//   npx tsx --env-file=.env.local scripts/spec78-dev-seed.ts --reset
//
// Looks up the merchant customer by the founder email TEJ_EMAIL (defaults
// to tejaasvi@gmail.com — the canonical local-dev founder per CLAUDE.md).
import { db } from '../lib/db'
import { users, customers, churnedSubscribers, recoveries, improvements } from '../lib/schema'
import { and, eq, inArray, sql } from 'drizzle-orm'

const TEJ_EMAIL = process.env.TEJ_EMAIL ?? 'tejaasvi@gmail.com'

type PromoMeta = {
  stripeCouponId:        string
  stripePromotionCodeId: string
  code:                  string
  name:                  string
  percentOff:            number
  amountOffCents:        number | null
  currency:              string | null
  duration:              'once' | 'repeating' | 'forever'
  durationInMonths:      number | null
  redeemBy:              string | null
  appliesToPriceIds:     string[]
  maxRedemptions:        number | null
  timesRedeemed:         number
  active:                boolean
  syncedAt:              string
}

const PROMO_WINBACK25: PromoMeta = {
  stripeCouponId:        'cpn_dev_winback25',
  stripePromotionCodeId: 'promo_dev_winback25',
  code:                  'WINBACK25',
  name:                  'Win back the price-sensitive',
  percentOff:            25,
  amountOffCents:        null,
  currency:              null,
  duration:              'repeating',
  durationInMonths:      3,
  redeemBy:              null,
  appliesToPriceIds:     [],
  maxRedemptions:        null,
  timesRedeemed:         0,
  active:                true,
  syncedAt:              new Date().toISOString(),
}

const PROMO_COMEBACK50: PromoMeta = {
  stripeCouponId:        'cpn_dev_comeback50',
  stripePromotionCodeId: 'promo_dev_comeback50',
  code:                  'COMEBACK50',
  name:                  'One-shot comeback',
  percentOff:            50,
  amountOffCents:        null,
  currency:              null,
  duration:              'once',
  durationInMonths:      null,
  redeemBy:              null,
  appliesToPriceIds:     [],
  maxRedemptions:        null,
  timesRedeemed:         0,
  active:                true,
  syncedAt:              new Date().toISOString(),
}

async function findCustomer(): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, TEJ_EMAIL)).limit(1)
  if (!u) throw new Error(`No wb_users row for ${TEJ_EMAIL}. Set TEJ_EMAIL env or register first.`)
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error(`No wb_customers row for user ${TEJ_EMAIL}. Complete onboarding first.`)
  return c.id
}

const DEV_SEED_TAG = 'spec78-dev-seed'

async function reset(customerId: string) {
  // Delete in FK-safe order: recoveries → subscribers → seeded improvements.
  const seedSubs = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      inArray(churnedSubscribers.stripeCustomerId, ['cus_dev_acme', 'cus_dev_storyflow']),
    ))
  const subIds = seedSubs.map((s) => s.id)
  if (subIds.length > 0) {
    await db.delete(recoveries).where(inArray(recoveries.subscriberId, subIds))
    await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, subIds))
    console.log(`[reset] deleted ${subIds.length} synthetic subscribers + their recoveries`)
  }
  // Delete the seed promo rows (matched by stripePromotionCodeId in the jsonb)
  const delPromos = await db.execute(sql`
    DELETE FROM wb_improvements
    WHERE customer_id = ${customerId}
      AND kind = 'promotion'
      AND promotion_metadata->>'stripePromotionCodeId' IN (
        ${PROMO_WINBACK25.stripePromotionCodeId},
        ${PROMO_COMEBACK50.stripePromotionCodeId}
      )
  `)
  // delPromos is implementation-specific; just print attempted
  console.log('[reset] removed seeded WINBACK25 + COMEBACK50 promo rows', delPromos)
}

async function upsertPromoImprovement(customerId: string, m: PromoMeta) {
  const existing = await db
    .select({ id: improvements.id, promotionMetadata: improvements.promotionMetadata })
    .from(improvements)
    .where(and(eq(improvements.customerId, customerId), eq(improvements.kind, 'promotion')))
  const match = existing.find((r) => {
    const meta = r.promotionMetadata as { stripePromotionCodeId?: string } | null
    return meta?.stripePromotionCodeId === m.stripePromotionCodeId
  })
  const title = `${m.code} — ${m.percentOff}% off${m.duration === 'once' ? ' · once' : m.durationInMonths ? ` · ${m.durationInMonths} months` : ' · forever'}`
  if (match) {
    await db.update(improvements).set({
      promotionMetadata: m as unknown as Record<string, unknown>,
      status: 'published',
      title,
      description: m.name ?? `Stripe promotion ${m.code}`,
      updatedAt: new Date(),
    }).where(eq(improvements.id, match.id))
    console.log(`[seed] updated promo improvement ${m.code} (${match.id})`)
    return match.id
  }
  const [row] = await db.insert(improvements).values({
    customerId,
    kind: 'promotion',
    title,
    description: m.name ?? `Stripe promotion ${m.code}`,
    dateShipped: new Date().toISOString().slice(0, 10),
    status: 'published',
    addressesPattern: null,
    preempted: false,
    promotionMetadata: m as unknown as Record<string, unknown>,
  }).returning({ id: improvements.id })
  console.log(`[seed] inserted promo improvement ${m.code} (${row.id})`)
  return row.id
}

async function upsertSyntheticRecovery(opts: {
  customerId: string
  stripeCustomerId: string
  email: string
  name: string
  planName: string
  mrrCents: number
  promotionCodeId: string | null
  daysAgo: number
}) {
  const { customerId, stripeCustomerId, email, name, planName, mrrCents, promotionCodeId, daysAgo } = opts
  const cancelledAt = new Date(Date.now() - daysAgo * 86_400_000)

  let [sub] = await db.select().from(churnedSubscribers).where(and(
    eq(churnedSubscribers.customerId, customerId),
    eq(churnedSubscribers.stripeCustomerId, stripeCustomerId),
  )).limit(1)

  if (!sub) {
    const [inserted] = await db.insert(churnedSubscribers).values({
      customerId,
      stripeCustomerId,
      email,
      name,
      planName,
      mrrCents,
      cancellationReason: 'Too expensive',
      cancellationCategory: 'Price',
      tier: 1,
      confidence: '0.92',
      triggerNeed: 'Cited price as the reason for cancelling.',
      triggerNeedConfidence: 'high',
      classifiedAt: new Date(),
      status: 'contacted',
      cancelledAt,
      source: DEV_SEED_TAG,
    }).returning()
    sub = inserted
    console.log(`[seed] inserted synthetic subscriber ${email}`)
  } else {
    console.log(`[seed] subscriber ${email} already present`)
  }

  // Upsert recovery
  const existingRec = await db.select({ id: recoveries.id }).from(recoveries)
    .where(eq(recoveries.subscriberId, sub.id)).limit(1)
  if (existingRec.length === 0) {
    await db.insert(recoveries).values({
      subscriberId: sub.id,
      customerId,
      planMrrCents: mrrCents,
      newStripeSubId: `sub_dev_${stripeCustomerId}`,
      attributionType: 'strong',
      recoveryType: 'win_back',
      appliedPromotionCodeId: promotionCodeId,
      recoveredAt: cancelledAt,
    })
    console.log(`[seed] inserted recovery for ${email}${promotionCodeId ? ` with promo ${promotionCodeId}` : ''}`)
  } else {
    await db.update(recoveries).set({
      appliedPromotionCodeId: promotionCodeId,
    }).where(eq(recoveries.id, existingRec[0].id))
    console.log(`[seed] updated recovery for ${email}`)
  }
}

async function main() {
  const wantReset = process.argv.includes('--reset')
  const customerId = await findCustomer()
  console.log(`[seed] customer: ${customerId} (${TEJ_EMAIL})`)

  if (wantReset) {
    await reset(customerId)
    console.log('[reset] done')
    return
  }

  await upsertPromoImprovement(customerId, PROMO_WINBACK25)
  await upsertPromoImprovement(customerId, PROMO_COMEBACK50)

  await upsertSyntheticRecovery({
    customerId,
    stripeCustomerId: 'cus_dev_acme',
    email: 'jenna@acme.com',
    name: 'Acme Corp',
    planName: 'Pro',
    mrrCents: 20000,
    promotionCodeId: PROMO_WINBACK25.stripePromotionCodeId,
    daysAgo: 6,
  })

  await upsertSyntheticRecovery({
    customerId,
    stripeCustomerId: 'cus_dev_storyflow',
    email: 'team@storyflow.app',
    name: 'StoryFlow',
    planName: 'Starter',
    mrrCents: 9900,
    promotionCodeId: PROMO_COMEBACK50.stripePromotionCodeId,
    daysAgo: 13,
  })

  console.log('\n[seed] done. Now visit:')
  console.log('  http://localhost:3000/reasons    ← Promotions card with 2 rows')
  console.log('  http://localhost:3000/settings   ← flip the new toggle (currently off)')
  console.log('  http://localhost:3000/dashboard  ← Acme + StoryFlow rows with promo chips under "Too expensive"')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
