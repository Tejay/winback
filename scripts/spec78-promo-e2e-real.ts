// Spec 78 followup — full end-to-end test for the promo flow.
//
// Drives both recovery paths against a real Stripe sandbox:
//   1. Resume:   subscriber's sub is set to cancel_at_period_end=true.
//                We auto-fire /api/reactivate → flips it back + attaches
//                the promo. We then verify the upcoming invoice has the
//                discount line.
//   2. Checkout: subscriber's sub is fully canceled. We auto-fire
//                /api/reactivate → creates a Stripe Checkout session with
//                discount preset. You open the URL in your browser, enter
//                4242, complete. The script polls Stripe + Winback DB
//                until the new subscription is paid + the perf-fee row
//                lands.
//
// Real things this touches:
//   • Stripe Connect (merchant tejaasvi@gmail.com, sandbox) — creates a
//     test product, price, coupon, promotion code, two test customers and
//     two subscriptions. Idempotent via stable identifiers.
//   • Winback DB — inserts/updates wb_improvements (promo rows),
//     wb_churned_subscribers, customer.selected_promotion_improvement_id,
//     wb_emails_sent, wb_recoveries.
//   • Resend — actually sends two emails to your inbox:
//       tejaasvi+winbackresume@gmail.com
//       tejaasvi+winbackcheckout@gmail.com
//   • LLM — generates the email body via generatePromotionEmail.
//
// Run:
//   npx tsx --env-file=.env.local scripts/spec78-promo-e2e-real.ts
//
// Reset (deletes the test product, price, coupons, promo codes, Stripe
// customers, subscriptions, AND the Winback rows tied to them):
//   npx tsx --env-file=.env.local scripts/spec78-promo-e2e-real.ts --reset
//
// Skip the checkout-path polling (resume only):
//   npx tsx --env-file=.env.local scripts/spec78-promo-e2e-real.ts --resume-only

import { db } from '../lib/db'
import {
  users,
  customers,
  churnedSubscribers,
  improvements,
  emailsSent,
  recoveries,
} from '../lib/schema'
import { and, eq, inArray, desc } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'
import {
  syncActivePromotionsFromStripe,
} from '../src/winback/lib/promotions'
import { processSubscriberForReengagement } from '../src/winback/lib/reengagement-cron-v2'

// ─── Constants ─────────────────────────────────────────────────────────
const MERCHANT_EMAIL          = 'tejaasvi@gmail.com'
const RECIPIENT_RESUME        = 'tejaasvi+winbackresume@gmail.com'
const RECIPIENT_CHECKOUT      = 'tejaasvi+winbackcheckout@gmail.com'
const STRIPE_CUSTOMER_TAG_RES = 'e2e-spec78-resume'
const STRIPE_CUSTOMER_TAG_CHK = 'e2e-spec78-checkout'
const PRODUCT_NAME            = 'E2E Spec78 Product'
const PRICE_NICKNAME          = 'e2e-spec78-monthly-1000'
const COUPON_ID               = 'e2e_spec78_winback25'
const PROMO_CODE_STRING       = 'WINBACKE2E25'
const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'

function banner(s: string) {
  console.log(`\n${'─'.repeat(70)}\n  ${s}\n${'─'.repeat(70)}`)
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Phase A: Resolve merchant + Stripe client ────────────────────────
async function getMerchant() {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, MERCHANT_EMAIL)).limit(1)
  if (!u) throw new Error(`No wb_users row for ${MERCHANT_EMAIL}`)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c?.stripeAccessToken) throw new Error(`No Stripe access token on ${MERCHANT_EMAIL}'s customer row`)
  return { customer: c, stripe: new Stripe(decrypt(c.stripeAccessToken)) }
}

// ─── Phase B: Idempotent Stripe seed ──────────────────────────────────
async function seedStripe(stripe: Stripe) {
  // Product (lookup by name)
  let product: Stripe.Product | undefined
  const prods = await stripe.products.list({ active: true, limit: 100 })
  product = prods.data.find((p) => p.name === PRODUCT_NAME)
  if (!product) {
    product = await stripe.products.create({ name: PRODUCT_NAME })
    console.log(`[stripe] created product ${product.id}`)
  } else {
    console.log(`[stripe] reusing product ${product.id}`)
  }

  // Price (lookup by nickname)
  let price: Stripe.Price | undefined
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 })
  price = prices.data.find((p) => p.nickname === PRICE_NICKNAME)
  if (!price) {
    price = await stripe.prices.create({
      product:    product.id,
      nickname:   PRICE_NICKNAME,
      currency:   'usd',
      unit_amount: 1000,
      recurring:  { interval: 'month' },
    })
    console.log(`[stripe] created price ${price.id}`)
  } else {
    console.log(`[stripe] reusing price ${price.id}`)
  }

  // Coupon (use fixed id so idempotent)
  let coupon: Stripe.Coupon
  try {
    coupon = await stripe.coupons.retrieve(COUPON_ID)
    console.log(`[stripe] reusing coupon ${coupon.id}`)
  } catch {
    coupon = await stripe.coupons.create({
      id:                 COUPON_ID,
      name:               '25% off for 3 months — e2e test',
      percent_off:        25,
      duration:           'repeating',
      duration_in_months: 3,
    })
    console.log(`[stripe] created coupon ${coupon.id}`)
  }

  // Promotion code (lookup by code). Stripe API ≥ 2026-03-25.dahlia
  // moved `coupon` under `promotion.coupon` (see CLAUDE.md). The SDK
  // types don't yet expose the new nested shape on create, so we cast.
  const promoList = await stripe.promotionCodes.list({ code: PROMO_CODE_STRING, limit: 5 })
  let promoCode = promoList.data.find((p) => p.code === PROMO_CODE_STRING && p.active)
  if (!promoCode) {
    promoCode = await stripe.promotionCodes.create({
      code: PROMO_CODE_STRING,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ promotion: { type: 'coupon', coupon: coupon.id } } as any),
    })
    console.log(`[stripe] created promotion code ${promoCode.id} (${promoCode.code})`)
  } else {
    console.log(`[stripe] reusing promotion code ${promoCode.id} (${promoCode.code})`)
  }

  return { product, price, coupon, promoCode }
}

// ─── Phase C: Sync into Winback + select the promo ─────────────────────
async function syncAndSelect(customerId: string, stripePromoCodeId: string) {
  const result = await syncActivePromotionsFromStripe(customerId)
  console.log(`[winback] synced ${result.synced} active, archived ${result.archived}`)

  // Find the wb_improvements row for the promo we created
  const rows = await db
    .select({ id: improvements.id, promotionMetadata: improvements.promotionMetadata })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customerId),
      eq(improvements.kind, 'promotion'),
      eq(improvements.status, 'published'),
    ))
  const match = rows.find((r) => {
    const m = r.promotionMetadata as { stripePromotionCodeId?: string } | null
    return m?.stripePromotionCodeId === stripePromoCodeId
  })
  if (!match) throw new Error(`Synced promo not found in wb_improvements (id ${stripePromoCodeId})`)
  console.log(`[winback] promo improvement row ${match.id}`)

  await db.update(customers).set({
    promotionsEnabled:               true,
    selectedPromotionImprovementId:  match.id,
    updatedAt:                       new Date(),
  }).where(eq(customers.id, customerId))
  console.log(`[winback] customer set: promotionsEnabled=true, selected=${match.id}`)

  return match.id
}

// ─── Phase D: Stripe test customers + subs ─────────────────────────────
async function createOrReuseStripeCustomer(
  stripe: Stripe,
  email: string,
  tag: string,
): Promise<Stripe.Customer> {
  const existing = await stripe.customers.list({ email, limit: 5 })
  const match = existing.data.find((c) => c.metadata?.e2e_tag === tag)
  if (match) {
    console.log(`[stripe] reusing customer ${match.id} (${email})`)
    return match
  }
  const c = await stripe.customers.create({
    email,
    name: 'E2E Test',
    metadata: { e2e_tag: tag },
  })
  console.log(`[stripe] created customer ${c.id} (${email})`)
  return c
}

// Attaches a working test PaymentMethod and makes it the default so the
// subscription can renew without prompting for a card. Uses Stripe's
// pm_card_visa test PaymentMethod (Stripe-hosted, no token round-trip).
async function attachDefaultPM(stripe: Stripe, customerId: string) {
  const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer
  if (customer.invoice_settings?.default_payment_method) {
    console.log(`[stripe] customer ${customerId} already has default PM`)
    return
  }
  const pm = await stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
  })
  await stripe.paymentMethods.attach(pm.id, { customer: customerId })
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: pm.id },
  })
  console.log(`[stripe] attached PM ${pm.id} to ${customerId}`)
}

// Creates a fresh subscription if the customer doesn't already have one
// matching the price. Returns the active sub. Note: the first invoice
// is paid immediately (subscription mode with PM attached).
async function ensureActiveSub(
  stripe: Stripe,
  customerId: string,
  priceId: string,
): Promise<Stripe.Subscription> {
  const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 })
  const existing = list.data.find((s) => s.items.data.some((it) => it.price.id === priceId) && (s.status === 'active' || s.status === 'trialing'))
  if (existing) {
    console.log(`[stripe] reusing active sub ${existing.id} for ${customerId}`)
    return existing
  }
  const sub = await stripe.subscriptions.create({
    customer:           customerId,
    items:              [{ price: priceId }],
    payment_behavior:   'default_incomplete',
    payment_settings:   { save_default_payment_method: 'on_subscription' },
    expand:             ['latest_invoice.payment_intent'],
  })
  console.log(`[stripe] created sub ${sub.id} status=${sub.status}`)
  // Pay the first invoice so the sub becomes active
  if (sub.latest_invoice && typeof sub.latest_invoice !== 'string') {
    try {
      await stripe.invoices.pay(sub.latest_invoice.id!, { paid_out_of_band: false })
    } catch (err) {
      console.warn(`[stripe] could not auto-pay first invoice: ${(err as Error).message}`)
    }
  }
  const refreshed = await stripe.subscriptions.retrieve(sub.id)
  console.log(`[stripe] sub ${sub.id} now status=${refreshed.status}`)
  return refreshed
}

// ─── Phase E: Seed Winback subscriber rows ────────────────────────────
async function upsertWinbackSubscriber(opts: {
  customerId: string
  email: string
  name: string
  stripeCustomerId: string
  stripeSubscriptionId: string | null
  stripePriceId: string
  mrrCents: number
  cancelledAt: Date
}) {
  const { customerId, email, name, stripeCustomerId, stripeSubscriptionId, stripePriceId, mrrCents, cancelledAt } = opts

  const [existing] = await db.select().from(churnedSubscribers).where(and(
    eq(churnedSubscribers.customerId, customerId),
    eq(churnedSubscribers.stripeCustomerId, stripeCustomerId),
  )).limit(1)

  if (existing) {
    await db.update(churnedSubscribers).set({
      stripeSubscriptionId,
      stripePriceId,
      email,
      name,
      mrrCents,
      cancellationReason:    'Too expensive — e2e test',
      cancellationCategory:  'Price',
      tier:                  1,
      confidence:            '0.95',
      triggerNeed:           'Cited price as the cancellation reason during e2e test.',
      triggerNeedConfidence: 'high',
      classifiedAt:          new Date(),
      status:                'pending',
      cancelledAt,
      reengagementSentAt:    null,     // re-allow re-engagement
      lastReengagedAt:       null,
      source:                'e2e-spec78-real',
      updatedAt:             new Date(),
    }).where(eq(churnedSubscribers.id, existing.id))
    console.log(`[winback] reset subscriber row ${existing.id} (${email})`)
    // Remove prior emails so the cron path will re-send
    await db.delete(emailsSent).where(eq(emailsSent.subscriberId, existing.id))
    await db.delete(recoveries).where(eq(recoveries.subscriberId, existing.id))
    return (await db.select().from(churnedSubscribers).where(eq(churnedSubscribers.id, existing.id)).limit(1))[0]
  }

  const [inserted] = await db.insert(churnedSubscribers).values({
    customerId,
    stripeCustomerId,
    stripeSubscriptionId,
    stripePriceId,
    email,
    name,
    planName:              'E2E Plan',
    mrrCents,
    cancellationReason:    'Too expensive — e2e test',
    cancellationCategory:  'Price',
    tier:                  1,
    confidence:            '0.95',
    triggerNeed:           'Cited price as the cancellation reason during e2e test.',
    triggerNeedConfidence: 'high',
    classifiedAt:          new Date(),
    status:                'pending',
    cancelledAt,
    source:                'e2e-spec78-real',
  }).returning()
  console.log(`[winback] inserted subscriber row ${inserted.id} (${email})`)
  return inserted
}

// ─── Phase H: Verification helpers ────────────────────────────────────
async function getLatestSentEmail(subscriberId: string) {
  const [row] = await db.select().from(emailsSent)
    .where(eq(emailsSent.subscriberId, subscriberId))
    .orderBy(desc(emailsSent.sentAt))
    .limit(1)
  return row
}

async function pollFor<T>(
  fn: () => Promise<T | null | undefined>,
  timeoutMs: number,
  pollEveryMs = 5000,
  label = 'condition',
): Promise<T> {
  const startedAt = Date.now()
  let lastLog = 0
  while (Date.now() - startedAt < timeoutMs) {
    const got = await fn()
    if (got) return got
    if (Date.now() - lastLog > 15_000) {
      console.log(`[poll] still waiting for ${label}... (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed)`)
      lastLog = Date.now()
    }
    await sleep(pollEveryMs)
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`)
}

// ─── Reset ────────────────────────────────────────────────────────────
async function reset(stripe: Stripe, customerId: string) {
  banner('RESET — removing all e2e artifacts')

  // Stripe customers
  for (const tag of [STRIPE_CUSTOMER_TAG_RES, STRIPE_CUSTOMER_TAG_CHK]) {
    const matches = await stripe.customers.search({ query: `metadata['e2e_tag']:'${tag}'` })
    for (const c of matches.data) {
      // Cancel any subs first (Stripe doesn't auto-cancel on customer delete in some accounts)
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 50 })
      for (const s of subs.data) {
        if (s.status !== 'canceled') {
          try { await stripe.subscriptions.cancel(s.id) } catch { /* ignore */ }
        }
      }
      await stripe.customers.del(c.id)
      console.log(`[reset] deleted Stripe customer ${c.id}`)
    }
  }

  // Promo code → archive then delete
  const promoList = await stripe.promotionCodes.list({ code: PROMO_CODE_STRING, limit: 5 })
  for (const p of promoList.data) {
    if (p.active) {
      try { await stripe.promotionCodes.update(p.id, { active: false }) } catch { /* ignore */ }
    }
    console.log(`[reset] deactivated promotion code ${p.id}`)
  }

  // Coupon delete (frees up the fixed id for re-create)
  try {
    await stripe.coupons.del(COUPON_ID)
    console.log(`[reset] deleted coupon ${COUPON_ID}`)
  } catch { /* not present */ }

  // Winback DB rows for our two synthetic subscribers
  const seedSubs = await db.select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      inArray(churnedSubscribers.email, [RECIPIENT_RESUME, RECIPIENT_CHECKOUT]),
    ))
  const subIds = seedSubs.map((s) => s.id)
  if (subIds.length > 0) {
    await db.delete(emailsSent).where(inArray(emailsSent.subscriberId, subIds))
    await db.delete(recoveries).where(inArray(recoveries.subscriberId, subIds))
    await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, subIds))
    console.log(`[reset] removed ${subIds.length} Winback subscriber rows + their emails/recoveries`)
  }

  // Clear the customer's selection if it pointed at our promo
  await db.update(customers).set({
    selectedPromotionImprovementId: null,
    updatedAt: new Date(),
  }).where(eq(customers.id, customerId))

  console.log('[reset] done')
}

// ─── Main ─────────────────────────────────────────────────────────────
async function main() {
  if (process.argv.includes('--reset')) {
    const { customer, stripe } = await getMerchant()
    await reset(stripe, customer.id)
    return
  }
  const resumeOnly = process.argv.includes('--resume-only')

  banner('PHASE A: Resolve merchant')
  const { customer, stripe } = await getMerchant()
  console.log(`merchant=${customer.id} (${MERCHANT_EMAIL})`)
  console.log(`stripe account=${customer.stripeAccountId ?? '(none — using platform key)'}`)

  banner('PHASE B: Seed Stripe (product, price, coupon, promotion code)')
  const { price, promoCode } = await seedStripe(stripe)

  banner('PHASE C: Sync Stripe promos into Winback + select WINBACKE2E25')
  await syncAndSelect(customer.id, promoCode.id)

  banner('PHASE D: Create test Stripe customers + active subs')
  const stripeCustResume = await createOrReuseStripeCustomer(stripe, RECIPIENT_RESUME, STRIPE_CUSTOMER_TAG_RES)
  const stripeCustCheckout = await createOrReuseStripeCustomer(stripe, RECIPIENT_CHECKOUT, STRIPE_CUSTOMER_TAG_CHK)
  await attachDefaultPM(stripe, stripeCustResume.id)
  await attachDefaultPM(stripe, stripeCustCheckout.id)

  // Resume sub: active, cancel_at_period_end=true
  const resumeSub = await ensureActiveSub(stripe, stripeCustResume.id, price.id)
  if (!resumeSub.cancel_at_period_end) {
    await stripe.subscriptions.update(resumeSub.id, { cancel_at_period_end: true })
    console.log(`[stripe] set ${resumeSub.id} cancel_at_period_end=true`)
  }

  // Checkout sub: fully canceled so the reactivate path falls through
  // to Stage 3 (Checkout creation).
  const checkoutSub = await ensureActiveSub(stripe, stripeCustCheckout.id, price.id)
  if (checkoutSub.status !== 'canceled') {
    await stripe.subscriptions.cancel(checkoutSub.id)
    console.log(`[stripe] canceled ${checkoutSub.id} (Stage 3 path)`)
  }

  banner('PHASE E: Seed Winback subscriber rows')
  const wbResume = await upsertWinbackSubscriber({
    customerId:           customer.id,
    email:                RECIPIENT_RESUME,
    name:                 'E2E Resume Test',
    stripeCustomerId:     stripeCustResume.id,
    stripeSubscriptionId: resumeSub.id,
    stripePriceId:        price.id,
    mrrCents:             1000,
    cancelledAt:          new Date(),
  })
  const wbCheckout = await upsertWinbackSubscriber({
    customerId:           customer.id,
    email:                RECIPIENT_CHECKOUT,
    name:                 'E2E Checkout Test',
    stripeCustomerId:     stripeCustCheckout.id,
    stripeSubscriptionId: checkoutSub.id,
    stripePriceId:        price.id,
    mrrCents:             1000,
    cancelledAt:          new Date(),
  })

  banner('PHASE F: Trigger re-engagement (real LLM call + real email send)')
  console.log('Sending to subscriber 1 (resume)...')
  const outcomeResume = await processSubscriberForReengagement(wbResume)
  console.log(`  outcome:`, outcomeResume)
  console.log('Sending to subscriber 2 (checkout)...')
  const outcomeCheckout = await processSubscriberForReengagement(wbCheckout)
  console.log(`  outcome:`, outcomeCheckout)

  banner('PHASE G: Inspect sent emails + extract reactivation links')
  const emailResume = await getLatestSentEmail(wbResume.id)
  const emailCheckout = await getLatestSentEmail(wbCheckout.id)
  if (!emailResume) console.warn('!! no email recorded for resume subscriber')
  if (!emailCheckout) console.warn('!! no email recorded for checkout subscriber')
  const resumeLink = `${BASE_URL}/api/reactivate/${wbResume.id}`
  const checkoutLink = `${BASE_URL}/api/reactivate/${wbCheckout.id}`
  console.log(`Resume email   → ${RECIPIENT_RESUME}`)
  console.log(`  subject: ${emailResume?.subject}`)
  console.log(`  link:    ${resumeLink}`)
  console.log(`Checkout email → ${RECIPIENT_CHECKOUT}`)
  console.log(`  subject: ${emailCheckout?.subject}`)
  console.log(`  link:    ${checkoutLink}`)

  banner('PHASE H: Auto-fire Resume path')
  const resumeResp = await fetch(resumeLink, { redirect: 'manual' })
  console.log(`GET ${resumeLink} → ${resumeResp.status} ${resumeResp.headers.get('location') ?? ''}`)

  // Verify discount on upcoming invoice
  await sleep(2000)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const upcoming = await (stripe as any).invoices.createPreview({ subscription: resumeSub.id }).catch(
    // Fallback for older Stripe API versions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => (stripe as any).invoices.retrieveUpcoming({ subscription: resumeSub.id }),
  )
  console.log(`Upcoming invoice on resume sub:`)
  console.log(`  subtotal:           ${upcoming.subtotal} ${upcoming.currency?.toUpperCase()}`)
  console.log(`  total:              ${upcoming.total}`)
  console.log(`  total_discount:     ${JSON.stringify(upcoming.total_discount_amounts ?? [])}`)
  console.log(`  discounts applied:  ${JSON.stringify(upcoming.discounts ?? upcoming.discount ?? '(none)')}`)
  const upcomingHasDiscount = (upcoming.total_discount_amounts?.length ?? 0) > 0
    || (Array.isArray(upcoming.discounts) && upcoming.discounts.length > 0)
    || !!upcoming.discount
  if (!upcomingHasDiscount) {
    console.warn('!! WARNING: upcoming invoice has NO discount — resume path did not attach the promo')
  } else {
    console.log('✓ Discount confirmed on the upcoming invoice for the resumed subscription.')
  }

  if (resumeOnly) {
    banner('DONE (--resume-only)')
    return
  }

  banner('PHASE I: Drive Checkout path')
  const checkoutResp = await fetch(checkoutLink, { redirect: 'manual' })
  const checkoutUrl = checkoutResp.headers.get('location')
  console.log(`GET ${checkoutLink} → ${checkoutResp.status}`)
  if (!checkoutUrl) {
    throw new Error(`No redirect from /api/reactivate (got ${checkoutResp.status})`)
  }
  const isChooser = checkoutUrl.includes('/reactivate/') && checkoutUrl.includes('?t=')
  const isDirectStripe = checkoutUrl.includes('checkout.stripe.com')
  if (isDirectStripe) {
    console.log(`Stripe Checkout URL (direct):\n  ${checkoutUrl}`)
  } else if (isChooser) {
    console.log(`Plan chooser URL (merchant has >1 active price):\n  ${checkoutUrl}`)
    console.log('Pick a plan on the chooser page → it will POST to create the Stripe Checkout session with the discount preset.')
  } else {
    throw new Error(`Unexpected redirect: ${checkoutUrl}`)
  }

  console.log('\n=================================================================')
  console.log('  MANUAL STEP — open the URL above in a browser.')
  if (isChooser) {
    console.log('  • Pick any plan on the chooser page.')
    console.log('  • You will be redirected to Stripe Checkout with the discount applied.')
  }
  console.log('  • Card: 4242 4242 4242 4242 · any future expiry · any CVC · any zip')
  console.log('  • Hit "Subscribe". The page will redirect to /welcome-back.')
  console.log('  Then come back here — this script will keep polling until')
  console.log('  the new subscription + perf-fee row land in Winback.')
  console.log('=================================================================\n')

  banner('PHASE J: Poll for recovery + first invoice with discount')
  const rec = await pollFor(
    async () => {
      const [r] = await db.select().from(recoveries).where(eq(recoveries.subscriberId, wbCheckout.id)).limit(1)
      return r ?? null
    },
    5 * 60 * 1000,
    5000,
    'wb_recoveries row for checkout subscriber',
  )
  console.log(`✓ Recovery row created: id=${rec.id} newStripeSubId=${rec.newStripeSubId} appliedPromotionCodeId=${rec.appliedPromotionCodeId}`)

  if (!rec.newStripeSubId) {
    console.warn('!! recovery has no newStripeSubId — cannot verify invoice')
    return
  }

  const newSub = await stripe.subscriptions.retrieve(rec.newStripeSubId, { expand: ['latest_invoice'] })
  console.log(`New sub status: ${newSub.status}`)

  const latestInvoice = typeof newSub.latest_invoice === 'string'
    ? await stripe.invoices.retrieve(newSub.latest_invoice)
    : newSub.latest_invoice as Stripe.Invoice | null
  if (!latestInvoice) {
    console.warn('!! no latest_invoice on the new sub yet')
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invAny = latestInvoice as any
    console.log(`First invoice on the new sub:`)
    console.log(`  id:                ${latestInvoice.id}`)
    console.log(`  status:            ${latestInvoice.status}`)
    console.log(`  amount_paid:       ${latestInvoice.amount_paid} ${latestInvoice.currency?.toUpperCase()}`)
    console.log(`  total_discount:    ${JSON.stringify(latestInvoice.total_discount_amounts ?? [])}`)
    console.log(`  discounts applied: ${JSON.stringify(invAny.discounts ?? invAny.discount ?? '(none)')}`)
    const hasDiscount = (latestInvoice.total_discount_amounts?.length ?? 0) > 0
      || (Array.isArray(invAny.discounts) && invAny.discounts.length > 0)
      || !!invAny.discount
    if (!hasDiscount) {
      console.warn('!! WARNING: first invoice has NO discount — promo did not flow through Checkout')
    } else {
      console.log('✓ Discount confirmed on the first invoice of the new (Checkout) subscription.')
    }
  }

  banner('PHASE K: Poll for perf-fee row (spec 78 deferred firing)')
  try {
    const rec2 = await pollFor(
      async () => {
        const [r] = await db.select().from(recoveries).where(eq(recoveries.id, rec.id)).limit(1)
        return r?.perfFeeAmountCents !== null && r?.perfFeeAmountCents !== undefined ? r : null
      },
      2 * 60 * 1000,
      5000,
      'perf_fee_amount_cents on recovery',
    )
    console.log(`✓ Perf fee charged: ${rec2.perfFeeAmountCents} cents (basis invoice ${rec2.perfFeeBasisInvoiceId})`)
  } catch (err) {
    console.warn(`!! ${(err as Error).message}`)
    console.warn(`   (this is expected if the Stripe Connect webhook isn't reaching localhost — use stripe-cli to forward)`)
  }

  banner('DONE — all phases executed')
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('\nE2E FAILED:', err)
  process.exit(1)
})
