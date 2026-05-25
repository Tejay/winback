// Lists every webhook endpoint on a Stripe account, with its type
// (Account vs Connect), URL, status, and the full sorted list of
// enabled events. Read-only — never modifies anything.
//
// Use to audit which events fire where, especially when:
//   - You suspect drift between sandbox and production
//   - You're debugging why a handler never fires
//   - You want to confirm add-webhook-events-promo.ts did the right thing
//
// Usage:
//
//   # Sandbox / test mode:
//   npx tsx --env-file=.env.local scripts/list-webhook-endpoints.ts
//
//   # Production:
//   STRIPE_SECRET_KEY=sk_live_… npx tsx scripts/list-webhook-endpoints.ts
//
// Type detection: a WebhookEndpoint is Connect when Stripe sets its
// `application` field. Account endpoints leave it null. The script
// surfaces both as a tag at the top of each block.

import 'dotenv/config'
import Stripe from 'stripe'
import { STRIPE_API_VERSION } from '../src/winback/lib/stripe'

async function main(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY env var is required')
  const mode = key.startsWith('sk_live_') ? 'LIVE' : key.startsWith('sk_test_') ? 'TEST' : '???'

  console.log(`Mode: ${mode}  (key prefix: ${key.slice(0, 9)}…)\n`)

  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION })
  const eps = await stripe.webhookEndpoints.list({ limit: 100 })
  console.log(`Found ${eps.data.length} endpoint(s).`)

  for (const ep of eps.data) {
    const isConnect = Boolean((ep as unknown as { application?: string | null }).application)
    console.log(`\n${ep.id}  [${isConnect ? 'Connect' : 'Account '}]`)
    console.log(`  url:    ${ep.url}`)
    console.log(`  status: ${ep.status}`)
    console.log(`  api_version: ${ep.api_version ?? '(default)'}`)
    console.log(`  events (${ep.enabled_events.length}):`)
    for (const e of [...ep.enabled_events].sort()) {
      console.log(`    · ${e}`)
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })
