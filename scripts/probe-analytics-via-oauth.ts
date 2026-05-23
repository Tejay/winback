/**
 * Variant B: query Stripe Analytics MRR using the merchant's OAuth
 * access token directly (no Stripe-Account header, no platform key).
 *
 *   tsx --env-file=.env.local scripts/probe-analytics-via-oauth.ts
 */

import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'

async function main(): Promise<void> {
  const [row] = await db
    .select({ stripeAccessToken: customers.stripeAccessToken })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(users.email, 'tejaasvi@gmail.com'))
    .limit(1)
  if (!row?.stripeAccessToken) {
    console.error('no oauth token')
    process.exit(1)
  }
  const token = decrypt(row.stripeAccessToken)

  const res = await fetch(
    'https://api.stripe.com/v2/data/analytics/metric_query',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Stripe-Version': '2026-04-22.preview',
      },
      body: JSON.stringify({
        metrics: [{ name: 'revenue.mrr' }],
        starts_at: '2026-05-22T00:00:00Z',
        ends_at: '2026-05-23T00:00:00Z',
        granularity: 'day',
        currency: 'usd',
      }),
    },
  )

  console.log('HTTP', res.status)
  console.log(await res.text())
}

main().catch((err) => {
  console.error('failed', err)
  process.exit(1)
})
