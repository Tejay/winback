/**
 * Probes the Stripe Analytics API (preview) against a connected
 * merchant account to see if `revenue.mrr` is queryable via the
 * Stripe-Account header pattern.
 *
 * Unlike production `fetchStripeReportedMrr`, this script does NOT
 * swallow failures — it prints the raw HTTP status, headers, and body
 * so we know exactly why the call succeeds or fails.
 *
 *   tsx --env-file=.env.local scripts/probe-stripe-analytics-mrr.ts <email>
 */

import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const ENDPOINT = 'https://api.stripe.com/v2/data/analytics/metric_query'
const STRIPE_VERSION = '2026-04-22.preview'

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'tejaasvi@gmail.com'
  const [row] = await db
    .select({
      customerId: customers.id,
      stripeAccountId: customers.stripeAccountId,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(users.email, email))
    .limit(1)
  if (!row) {
    console.error(`no customer for ${email}`)
    process.exit(1)
  }
  if (!row.stripeAccountId) {
    console.error(`customer ${row.customerId} has no stripeAccountId`)
    process.exit(1)
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY not set')
    process.exit(1)
  }

  const now = new Date()
  const startsAt = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const body = {
    metrics: [{ name: 'revenue.mrr' }],
    starts_at: startsAt.toISOString(),
    ends_at: now.toISOString(),
    granularity: 'day',
    currency: 'usd',
  }

  console.log(`POST ${ENDPOINT}`)
  console.log(`  Stripe-Version: ${STRIPE_VERSION}`)
  console.log(`  Stripe-Account: ${row.stripeAccountId}`)
  console.log(`  body: ${JSON.stringify(body)}`)
  console.log('')

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      'Stripe-Version': STRIPE_VERSION,
      'Stripe-Account': row.stripeAccountId,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })

  console.log(`HTTP ${res.status} ${res.statusText}`)
  console.log('response headers:')
  res.headers.forEach((v, k) => console.log(`  ${k}: ${v}`))
  console.log('')

  const text = await res.text()
  console.log('response body:')
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
}

main().catch((err) => {
  console.error('script failed', err)
  process.exit(1)
})
