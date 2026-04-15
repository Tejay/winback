// Run with: npx tsx scripts/test-exit-email.ts <email>
// Seeds a churned-subscriber row and fires scheduleExitEmail once.
import 'dotenv/config'
import { db } from '../lib/db'
import { customers, churnedSubscribers } from '../lib/schema'
import { scheduleExitEmail } from '../src/winback/lib/email'
import type { ClassificationResult } from '../src/winback/lib/types'

async function main() {
  const email = process.argv[2]
  if (!email) {
    console.error('Usage: npx tsx scripts/test-exit-email.ts <email>')
    process.exit(1)
  }

  const [customer] = await db.select().from(customers).limit(1)
  if (!customer) throw new Error('No customer row — register an account first')

  const [sub] = await db.insert(churnedSubscribers).values({
    customerId: customer.id,
    stripeCustomerId: 'cus_smoketest_' + Date.now(),
    email,
    name: 'Smoke Test',
    planName: 'Pro',
    mrrCents: 4900,
    status: 'pending',
  }).returning({ id: churnedSubscribers.id })

  console.log(`Seeded subscriber: ${sub.id}  (email=${email})`)

  const classification: ClassificationResult = {
    tier: 1,
    tierReason: 'Smoke test',
    cancellationReason: 'Testing Tier 1 GDPR email flow',
    cancellationCategory: 'Other',
    confidence: 0.9,
    suppress: false,
    firstMessage: {
      subject: '[Winback smoke test] Quick note on your cancellation',
      body: `Hi there,\n\nThis is a Tier 1 smoke test — if you're reading this in your inbox, the GDPR-compliant email pipeline is working end to end.\n\nThings to check in this message:\n• Does the "unsubscribe" link at the bottom open ${process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'}/unsubscribed?\n• Does Gmail show a one-click unsubscribe option in the header menu? (List-Unsubscribe)\n• Does the from address show "reply+<id>@winbackflow.co"?\n\nThanks for testing.`,
      sendDelaySecs: 0,
    },
    triggerKeyword: null,
    fallbackDays: 90,
    winBackSubject: '',
    winBackBody: '',
  }

  await scheduleExitEmail({
    subscriberId: sub.id,
    email,
    classification,
    fromName: customer.founderName ?? 'Winback test',
  })

  console.log(`✓ scheduleExitEmail completed`)
  console.log(`\nTo clean up after you've checked the inbox:`)
  console.log(`  psql "$DATABASE_URL" -c "DELETE FROM wb_churned_subscribers WHERE id = '${sub.id}';"`)
}

main().catch((err) => { console.error(err); process.exit(1) })
