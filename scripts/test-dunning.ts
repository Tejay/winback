// Run with: npx tsx scripts/test-dunning.ts
import { db } from '../lib/db'
import { customers, churnedSubscribers, emailsSent } from '../lib/schema'
import { eq, and } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import { sendDunningEmail } from '../src/winback/lib/email'
import { users } from '../lib/schema'
import Stripe from 'stripe'

async function testDunning() {
  console.log('=== Testing Dunning Email Flow ===\n')

  // Get the connected customer
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeAccountId, 'acct_1TKz65Bg1NnlAr3m'))
    .limit(1)

  if (!customer) {
    console.log('No connected customer found')
    return
  }
  console.log('Customer:', customer.id)

  // Use a customer not already in wb_churned_subscribers
  const stripeCustomerId = 'cus_UKUn0slkHuRbMN' // Mark Failed
  const accessToken = decrypt(customer.stripeAccessToken!)
  const stripe = new Stripe(accessToken)

  // Fetch customer details from Stripe
  const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer
  console.log('Stripe customer:', stripeCustomer.name, stripeCustomer.email)

  // Get current payment method for attribution
  const currentPM = stripeCustomer.invoice_settings?.default_payment_method
  const paymentMethodId = typeof currentPM === 'string' ? currentPM : currentPM?.id ?? null
  console.log('Payment method:', paymentMethodId)

  // Create subscriber record for dunning
  const [existing] = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomerId),
        eq(churnedSubscribers.cancellationReason, 'Payment failed')
      )
    )
    .limit(1)

  let subscriberId: string
  if (existing) {
    subscriberId = existing.id
    console.log('Existing dunning subscriber:', subscriberId)
  } else {
    const [newSub] = await db
      .insert(churnedSubscribers)
      .values({
        customerId: customer.id,
        stripeCustomerId,
        stripeSubscriptionId: 'sub_test_dunning',
        email: stripeCustomer.email,
        name: stripeCustomer.name,
        planName: 'Pro Plan',
        mrrCents: 3900,
        cancellationReason: 'Payment failed',
        cancellationCategory: 'Other',
        tier: 2,
        confidence: '0.90',
        status: 'pending',
        paymentMethodAtFailure: paymentMethodId,
      })
      .returning({ id: churnedSubscribers.id })

    subscriberId = newSub.id
    console.log('Created dunning subscriber:', subscriberId)
  }

  // Get founder name
  const [user] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, customer.userId))
    .limit(1)
  const fromName = customer.founderName ?? user?.name ?? 'The team'

  // Send dunning email
  const nextRetryDate = new Date()
  nextRetryDate.setDate(nextRetryDate.getDate() + 7)

  console.log('\nSending dunning email...')
  await sendDunningEmail({
    subscriberId,
    email: stripeCustomer.email!,
    customerName: stripeCustomer.name ?? null,
    planName: 'Pro Plan',
    amountDue: 3900,
    currency: 'gbp',
    nextRetryDate,
    fromName,
  })

  console.log('Dunning email sent!')

  // Verify in DB
  const [emailRecord] = await db
    .select()
    .from(emailsSent)
    .where(
      and(
        eq(emailsSent.subscriberId, subscriberId),
        eq(emailsSent.type, 'dunning')
      )
    )
    .limit(1)

  console.log('\nEmail record:', emailRecord ? 'Created ✅' : 'Missing ❌')
  if (emailRecord) {
    console.log('  Type:', emailRecord.type)
    console.log('  Subject:', emailRecord.subject)
    console.log('  Message ID:', emailRecord.gmailMessageId)
  }

  // Check subscriber status
  const [updated] = await db
    .select({ status: churnedSubscribers.status })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  console.log('  Subscriber status:', updated?.status)
  console.log('\n=== Test Complete ===')
  console.log(`\nCheck your inbox at ${stripeCustomer.email}`)
  console.log(`Update payment link: http://localhost:3000/api/update-payment/${subscriberId}`)
}

testDunning().catch(console.error).finally(() => process.exit(0))
