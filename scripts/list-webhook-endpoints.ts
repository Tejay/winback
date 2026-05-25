// Lists every webhook endpoint on a Stripe account, with its type
// (Account vs Connect), URL, status, and the full sorted list of
// enabled events. Read-only — never modifies anything.
//
// Use to audit which events fire where, especially when:
//   - You suspect drift between sandbox and production
//   - You're debugging why a handler never fires
//   - You want to confirm add-webhook-events-promo.ts did the right thing
//
// Key selection: prefers STRIPE_RESTRICTED_KEY when present, falls back
// to STRIPE_SECRET_KEY. Use a restricted key (rk_live_…) for prod audits
// — Stripe → Developers → API keys → Create restricted key, grant
// "Webhook endpoints: Read", save in .env.production.tmp.
//
// Usage:
//
//   # Sandbox / test mode (uses STRIPE_SECRET_KEY from .env.local):
//   npx tsx --env-file=.env.local scripts/list-webhook-endpoints.ts
//
//   # Production via restricted key (recommended — least privilege):
//   #   .env.production.tmp must contain STRIPE_RESTRICTED_KEY=rk_live_…
//   npx tsx --env-file=.env.production.tmp scripts/list-webhook-endpoints.ts
//
//   # Production via full secret key (one-off, key passed inline):
//   STRIPE_SECRET_KEY=sk_live_… npx tsx scripts/list-webhook-endpoints.ts
//
// Type detection: a WebhookEndpoint is Connect when Stripe sets its
// `application` field. Account endpoints leave it null. The script
// surfaces both as a tag at the top of each block.

import 'dotenv/config'
import Stripe from 'stripe'
import { STRIPE_API_VERSION } from '../src/winback/lib/stripe'

function detectMode(key: string): 'LIVE' | 'TEST' | '???' {
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'LIVE'
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'TEST'
  return '???'
}

function resolveKey(): { key: string; varName: 'STRIPE_RESTRICTED_KEY' | 'STRIPE_SECRET_KEY' } {
  const restricted = process.env.STRIPE_RESTRICTED_KEY
  if (restricted) return { key: restricted, varName: 'STRIPE_RESTRICTED_KEY' }
  const secret = process.env.STRIPE_SECRET_KEY
  if (secret) return { key: secret, varName: 'STRIPE_SECRET_KEY' }
  throw new Error('Neither STRIPE_RESTRICTED_KEY nor STRIPE_SECRET_KEY is set in env')
}

async function main(): Promise<void> {
  const { key, varName } = resolveKey()
  const mode = detectMode(key)

  console.log(`Mode: ${mode}  (using ${varName}, prefix: ${key.slice(0, 9)}…)\n`)

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
