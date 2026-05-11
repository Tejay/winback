// Check Stripe's webhook delivery log for events on the Connect application
// of tejaasvi@gmail.com. Reads the events API + tries to surface failure reasons.
// Read-only.
// Run: npx tsx --env-file=.env.local scripts/billing-test-check-delivery.ts

import { db } from '../lib/db'
import { customers, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

async function main() {
  const TARGET_EMAIL = 'tejaasvi@gmail.com'
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error('no Connect token'); process.exit(1) }

  const connect = new Stripe(decrypt(c.stripeAccessToken))

  console.log('=== Recent events on Connect account ===')
  const events = await connect.events.list({ limit: 15 })
  for (const e of events.data) {
    console.log(`  ${new Date(e.created * 1000).toISOString()}  ${e.type}`)
    console.log(`    id=${e.id}  pending_webhooks=${e.pending_webhooks}`)
    // Try to surface the object the event references
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = e.data.object as any
    if (obj?.id) console.log(`    object: ${obj.id}  (${obj.object})`)
  }

  console.log('\n=== Endpoint attempts (no SDK method — use Stripe Dashboard) ===')
  console.log('Stripe API does not expose webhook delivery attempts via SDK.')
  console.log('Check manually in Stripe Dashboard → Developers → Webhooks → click endpoint → "Events" tab.')
  console.log()
  console.log('Webhook endpoint that should have received Connect events:')
  console.log('  https://winbackflow.co/api/stripe/webhook  (enabled)')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
