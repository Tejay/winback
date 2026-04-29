/**
 * Spec 34 verification — fire 5 dunning emails to the same subscriber,
 * each with a different `last_decline_code` set on the row, so the
 * inbox shows the bespoke "Why this happened" + "Best next step" copy
 * for each bucket side-by-side.
 *
 * Run with: npx tsx --env-file=.env.local scripts/test-spec34-decline-scenarios.ts
 *
 * Targets the existing dunning subscriber (tejaasvi+e2edun@gmail.com).
 * Idempotency dedupe lets Resend re-send each time without writing a
 * new wb_emails_sent row.
 */
import { db } from '../lib/db'
import { customers, churnedSubscribers, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { sendDunningFollowupEmail } from '../src/winback/lib/email'

const SUBSCRIBER_ID = '38a705a6-3290-44e9-9971-193a7973d940'

const SCENARIOS: { code: string | null; label: string }[] = [
  { code: 'expired_card',           label: 'Expired bucket — "Your card expired"' },
  { code: 'insufficient_funds',     label: 'Insufficient funds bucket' },
  { code: 'do_not_honor',           label: 'Bank declined bucket — "call the number"' },
  { code: 'card_velocity_exceeded', label: 'Fraud review bucket — "your bank flagged"' },
  { code: 'processing_error',       label: 'Temporary bucket — Update CTA SUPPRESSED' },
  { code: null,                     label: 'Fallback bucket — generic copy (control)' },
]

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('=== Spec 34 — decline-aware dunning copy ===\n')

  const [sub] = await db.select().from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, SUBSCRIBER_ID)).limit(1)
  if (!sub) {
    console.error('subscriber not found:', SUBSCRIBER_ID)
    process.exit(1)
  }

  const [customer] = await db.select().from(customers)
    .where(eq(customers.id, sub.customerId)).limit(1)
  const [user] = customer
    ? await db.select({ name: users.name }).from(users).where(eq(users.id, customer.userId)).limit(1)
    : []
  const fromName = customer?.founderName ?? user?.name ?? 'The team'

  console.log('Subscriber:', sub.id, '→', sub.email)
  console.log('From:     ', fromName, '\n')

  const baseRetry = new Date(Date.now() + 24 * 60 * 60 * 1000)

  for (let i = 0; i < SCENARIOS.length; i++) {
    const { code, label } = SCENARIOS[i]
    console.log(`[${i + 1}/${SCENARIOS.length}] ${label}`)
    console.log(`        last_decline_code = ${JSON.stringify(code)}`)

    // 1. Set the decline code on the row.
    await db
      .update(churnedSubscribers)
      .set({ lastDeclineCode: code, updatedAt: new Date() })
      .where(eq(churnedSubscribers.id, sub.id))

    // 2. Send a T2 (Heads up, retry coming) so we get the bespoke
    //    "Why this happened" + "Best next step" structure with the
    //    button (or its absence for processing_error) clearly visible.
    await sendDunningFollowupEmail({
      subscriberId: sub.id,
      email:        sub.email!,
      customerName: sub.name,
      planName:     sub.planName ?? 'Pro Plan',
      amountDue:    sub.mrrCents,
      currency:     'usd',
      retryDate:    new Date(baseRetry.getTime() + i * 24 * 60 * 60 * 1000),
      fromName,
      isFinalRetry: false,
    })
    console.log('        sent ✓\n')

    // Small gap so emails arrive in sequence rather than batching.
    await sleep(1500)
  }

  console.log('All 6 emails fired. Check inbox at:', sub.email)
  console.log('\nExpect to see (in order):')
  for (const { label } of SCENARIOS) {
    console.log('  -', label)
  }
  console.log('\nThe processing_error one should NOT have an "Update payment" button — that\'s the suppression check.')
  console.log('Restoring lastDeclineCode to NULL for cleanup…')
  await db.update(churnedSubscribers)
    .set({ lastDeclineCode: null, updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, sub.id))
  console.log('done.')
}

main().catch((err) => { console.error(err); process.exit(1) }).finally(() => process.exit(0))
