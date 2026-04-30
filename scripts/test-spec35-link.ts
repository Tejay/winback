// Spec 35 verification — re-send a dunning email to an existing dunning
// subscriber so the inbox copy contains the new /api/update-payment link
// (which now redirects to a Stripe Checkout Session rather than the
// Billing Portal).
//
// Run with: npx tsx --env-file=.env.local scripts/test-spec35-link.ts
//
// Targets the existing subscriber from the Spec 33 e2e test
// (tejaasvi+e2edun@gmail.com — already in `Payment failed` state).
import { db } from '../lib/db'
import { customers, churnedSubscribers, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { sendDunningEmail } from '../src/winback/lib/email'

const SUBSCRIBER_ID = '38a705a6-3290-44e9-9971-193a7973d940'

async function main() {
  console.log('=== Spec 35 link verification ===\n')

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
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, customer.userId))
        .limit(1)
    : []

  const fromName = customer?.productName ?? customer?.founderName ?? user?.name ?? 'The team'

  console.log('Subscriber:', sub.id, '→', sub.email)
  console.log('Plan:     ', sub.planName, sub.mrrCents, 'cents')
  console.log('From:     ', fromName)

  const nextRetryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)

  console.log('\nSending dunning email…')
  await sendDunningEmail({
    subscriberId: sub.id,
    email:        sub.email!,
    customerName: sub.name,
    planName:     sub.planName ?? 'Pro Plan',
    amountDue:    sub.mrrCents,
    currency:     'usd',
    nextRetryDate,
    fromName,
  })
  console.log('Sent.')
  console.log('\nCheck:', sub.email)
  console.log('Update-payment link inside the email →')
  console.log('  ' + (process.env.NEXT_PUBLIC_APP_URL ?? '(NEXT_PUBLIC_APP_URL unset)') + '/api/update-payment/' + sub.id)
  console.log('  Should redirect to checkout.stripe.com (Spec 35), NOT billing.stripe.com')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => process.exit(0))
