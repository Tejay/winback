// Spec 37 verification — send T1 + T2 + T3 dunning emails to the same
// subscriber so you can see the new HTML rendering side-by-side.
//
// Run with: npx tsx --env-file=.env.local scripts/test-spec37-emails.ts
//
// Re-uses the existing dunning subscriber from earlier e2e tests
// (tejaasvi+e2edun@gmail.com — already in `Payment failed` state).
//
// Idempotency note: T1 was previously sent to this subscriber. The
// re-send will hit the unique-index dedupe — but Resend's API call runs
// BEFORE the dedupe DB write, so the email still goes out. The dedupe
// helper now correctly recognises the wrapped DrizzleQueryError and
// logs "treating as success" rather than re-throwing.
import { db } from '../lib/db'
import { customers, churnedSubscribers, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { sendDunningEmail, sendDunningFollowupEmail } from '../src/winback/lib/email'

const SUBSCRIBER_ID = '38a705a6-3290-44e9-9971-193a7973d940'

async function main() {
  console.log('=== Spec 37 — sending T1 + T2 + T3 ===\n')

  const [sub] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, SUBSCRIBER_ID))
    .limit(1)

  if (!sub) {
    console.error('subscriber not found:', SUBSCRIBER_ID)
    process.exit(1)
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, sub.customerId))
    .limit(1)

  const [user] = customer
    ? await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, customer.userId))
        .limit(1)
    : []

  const fromName = customer?.founderName ?? user?.name ?? 'The team'
  const baseRetry = new Date(Date.now() + 24 * 60 * 60 * 1000) // ~24h out

  console.log('Subscriber:', sub.id, '→', sub.email)
  console.log('From:     ', fromName, '\n')

  // ─── T1 — sendDunningEmail with a retry date set ─────────────────
  console.log('[T1] sendDunningEmail (Heads up, retry coming)…')
  await sendDunningEmail({
    subscriberId: sub.id,
    email:        sub.email!,
    customerName: sub.name,
    planName:     sub.planName ?? 'Pro Plan',
    amountDue:    sub.mrrCents,
    currency:     'usd',
    nextRetryDate: baseRetry,
    fromName,
  })
  console.log('  sent ✓')

  // ─── T2 — sendDunningFollowupEmail (Heads up, retry coming) ──────
  console.log('[T2] sendDunningFollowupEmail isFinalRetry: false…')
  await sendDunningFollowupEmail({
    subscriberId: sub.id,
    email:        sub.email!,
    customerName: sub.name,
    planName:     sub.planName ?? 'Pro Plan',
    amountDue:    sub.mrrCents,
    currency:     'usd',
    retryDate:    new Date(baseRetry.getTime() + 7 * 24 * 60 * 60 * 1000),
    fromName,
    isFinalRetry: false,
  })
  console.log('  sent ✓')

  // ─── T3 — sendDunningFollowupEmail (Final reminder, one-shot) ────
  console.log('[T3] sendDunningFollowupEmail isFinalRetry: true…')
  await sendDunningFollowupEmail({
    subscriberId: sub.id,
    email:        sub.email!,
    customerName: sub.name,
    planName:     sub.planName ?? 'Pro Plan',
    amountDue:    sub.mrrCents,
    currency:     'usd',
    retryDate:    new Date(baseRetry.getTime() + 14 * 24 * 60 * 60 * 1000),
    fromName,
    isFinalRetry: true,
  })
  console.log('  sent ✓')

  console.log('\nCheck inbox at:', sub.email)
  console.log('Expect 3 messages — T1 (Heads up, "we\'ll try again"),')
  console.log('                    T2 (Heads up, "we\'ll try again", 7d-out date),')
  console.log('                    T3 (Final reminder, "one final time").')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => process.exit(0))
