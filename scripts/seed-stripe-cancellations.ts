/**
 * Manual-testing seed: wipe tejaasvi@gmail.com's churned subscribers, then
 * create 5 fresh cancellations from REAL Stripe test-mode customers and run
 * the classifier so exit emails go out.
 *
 * Flow per persona (mirrors the production webhook → processChurn path):
 *   1. Create a Stripe test customer + active subscription (send_invoice, so
 *      no card needed) on the merchant's connected account.
 *   2. Cancel it with cancellation_details (feedback + comment) — a real
 *      Tier-1 signal.
 *   3. extractSignals() off the cancelled subscription and insert a
 *      wb_churned_subscribers row exactly as the webhook would (status
 *      'pending', classified_at NULL, source 'webhook').
 * Then runClassifierTick() once → classifies all 5 + sends exit emails.
 *
 * All recipient emails are tejaasvi+wbN@gmail.com (plus-addressing → your
 * inbox) so you can open each exit email and reply to test the inbound flow.
 *
 * SAFETY:
 *   - Aborts unless the merchant Stripe key starts with sk_test_.
 *   - The wipe is scoped to THIS merchant's churned subscribers (+ their
 *     emails/replies/recoveries). The merchant account + Stripe connection
 *     are left intact.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-stripe-cancellations.ts
 *   npx tsx --env-file=.env.local scripts/seed-stripe-cancellations.ts --wipe-only
 */
import Stripe from 'stripe'
import { eq, and, inArray } from 'drizzle-orm'
import { db } from '../lib/db'
import { users, customers, churnedSubscribers, emailsSent, subscriberReplies, recoveries } from '../lib/schema'
import { decrypt } from '../src/winback/lib/encryption'
import { extractSignals } from '../src/winback/lib/stripe'
import { runClassifierTick } from '../src/winback/lib/classifier-tick'

const MERCHANT_EMAIL = 'tejaasvi@gmail.com'

type Persona = {
  email: string
  name: string
  feedback: Stripe.SubscriptionCancelParams.CancellationDetails['feedback']
  comment: string
}

const PERSONAS: Persona[] = [
  { email: 'tejaasvi+wb1@gmail.com', name: 'Marcus Hale',  feedback: 'missing_features', comment: 'No Slack integration — that was the only reason I signed up. Without it the workflow breaks.' },
  { email: 'tejaasvi+wb2@gmail.com', name: 'Priya Anand',  feedback: 'too_expensive',    comment: 'Love the product but the Pro price is steep for how little I use it lately. Is there a cheaper tier?' },
  { email: 'tejaasvi+wb3@gmail.com', name: 'Devon Park',   feedback: 'switched_service', comment: 'Moved my team to a competitor that offers live coached classes.' },
  { email: 'tejaasvi+wb4@gmail.com', name: 'Lena Fischer', feedback: 'other',            comment: "Travelling for a couple of months and didn't want to pay while I can't use it. Any way to pause?" },
  { email: 'tejaasvi+wb5@gmail.com', name: 'Sam Lee',      feedback: 'unused',           comment: "Honestly just don't use it much anymore." },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function resolveMerchant() {
  const [row] = await db
    .select({ id: customers.id, accountId: customers.stripeAccountId, token: customers.stripeAccessToken, product: customers.productName })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(users.email, MERCHANT_EMAIL))
    .limit(1)
  if (!row) throw new Error(`No customer for ${MERCHANT_EMAIL}`)
  if (!row.token) throw new Error('Merchant has no Stripe access token')
  return { id: row.id, accountId: row.accountId!, token: decrypt(row.token), product: row.product }
}

async function wipe(merchantId: string) {
  const subs = await db.select({ id: churnedSubscribers.id }).from(churnedSubscribers).where(eq(churnedSubscribers.customerId, merchantId))
  const ids = subs.map((s) => s.id)
  if (ids.length === 0) { console.log('Wipe: no existing churned subscribers.'); return }
  // recoveries first (FK), then churned (emails + replies cascade on delete).
  await db.delete(recoveries).where(inArray(recoveries.subscriberId, ids))
  await db.delete(emailsSent).where(inArray(emailsSent.subscriberId, ids))
  await db.delete(subscriberReplies).where(inArray(subscriberReplies.subscriberId, ids))
  await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, ids))
  console.log(`Wipe: removed ${ids.length} churned subscriber(s) + their emails/replies/recoveries.`)
}

async function main() {
  const wipeOnly = process.argv.includes('--wipe-only')
  const merchant = await resolveMerchant()

  if (!merchant.token.startsWith('sk_test_')) {
    console.error("\n✗ ABORT: merchant Stripe key is not sk_test_. Refusing to create/cancel real subscriptions.\n")
    process.exit(1)
  }
  console.log(`Merchant ${MERCHANT_EMAIL} · customer ${merchant.id} · ${merchant.product} · Stripe TEST ✓\n`)

  await wipe(merchant.id)
  if (wipeOnly) { console.log('\n--wipe-only: done.'); process.exit(0) }

  const stripe = new Stripe(merchant.token)
  const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 5 })
  if (prices.data.length === 0) throw new Error('No active recurring prices on merchant account')
  const price = prices.data[0]
  console.log(`Using price ${price.id} (${(price.unit_amount ?? 0) / 100} ${price.currency}/${price.recurring?.interval})\n`)

  const insertedIds: string[] = []
  for (const p of PERSONAS) {
    process.stdout.write(`• ${p.name.padEnd(14)} (${p.feedback}) … `)
    const cust = await stripe.customers.create({ email: p.email, name: p.name })
    const sub = await stripe.subscriptions.create({
      customer: cust.id,
      items: [{ price: price.id }],
      collection_method: 'send_invoice',
      days_until_due: 30,
    })
    await sleep(1200)
    const cancelled = await stripe.subscriptions.cancel(sub.id, {
      cancellation_details: { feedback: p.feedback, comment: p.comment },
    })

    // Give any active Stripe webhook a beat to land its own row first.
    await sleep(800)
    const signals = await extractSignals(cancelled, merchant.token)
    // Race-safe: a live webhook may have already inserted this row
    // (onConflictDoNothing mirrors processChurn). Fetch the id either way.
    await db.insert(churnedSubscribers).values({
      customerId: merchant.id,
      stripeCustomerId: signals.stripeCustomerId,
      stripeSubscriptionId: signals.stripeSubscriptionId,
      stripePriceId: signals.stripePriceId,
      email: signals.email,
      name: signals.name,
      planName: signals.planName,
      mrrCents: signals.mrrCents,
      tenureDays: signals.tenureDays,
      everUpgraded: signals.everUpgraded,
      nearRenewal: signals.nearRenewal,
      paymentFailures: signals.paymentFailures,
      previousSubs: signals.previousSubs,
      stripeEnum: signals.stripeEnum,
      stripeComment: signals.stripeComment,
      status: 'pending',
      fallbackDays: 90,
      cancelledAt: signals.cancelledAt,
      source: 'webhook',
    }).onConflictDoNothing()
    const [row] = await db
      .select({ id: churnedSubscribers.id })
      .from(churnedSubscribers)
      .where(and(eq(churnedSubscribers.customerId, merchant.id), eq(churnedSubscribers.stripeCustomerId, signals.stripeCustomerId)))
      .limit(1)
    insertedIds.push(row.id)
    console.log(`row ${row.id}`)
  }

  console.log(`\nInserted ${insertedIds.length} churned rows. Running classifier (Anthropic + Resend)…\n`)
  const stats = await runClassifierTick()
  console.log(`Classifier: picked=${stats.picked} classified=${stats.classified} exitEmailsSent=${stats.exitEmailsSent} failed=${stats.failed}`)

  console.log(`\n✓ Done. Refresh the dashboard. Exit emails sent to tejaasvi+wb1..5@gmail.com (your inbox).`)
  console.log(`  Reply to any of them to test the inbound re-classification flow.`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
