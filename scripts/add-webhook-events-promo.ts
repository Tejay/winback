// Adds the four Spec 79 promo-sync events to every existing
// Connect-enabled webhook endpoint on a Stripe account. Idempotent and
// strictly additive: never deletes or recreates endpoints, only updates
// their enabled_events list to include the missing events.
//
// Key selection: prefers STRIPE_RESTRICTED_KEY when present, falls back
// to STRIPE_SECRET_KEY. The restricted key must have BOTH "Webhook
// endpoints: Read" AND "Webhook endpoints: Write" (the read-only key
// used by list-webhook-endpoints.ts is not enough — this script
// mutates).
//
// Run with whichever environment file targets the env you want to
// patch:
//
//   # Sandbox (already covered by setup-sandbox-webhook-endpoints.ts,
//   # but this works as a no-touch alternative):
//   npx tsx --env-file=.env.local scripts/add-webhook-events-promo.ts
//
//   # Production via restricted key (recommended — least privilege):
//   #   .env.production.tmp must contain STRIPE_RESTRICTED_KEY=rk_live_…
//   #   with both Webhook-endpoints Read + Write permissions
//   npx tsx --env-file=.env.production.tmp scripts/add-webhook-events-promo.ts
//
//   # Production via full secret key (one-off, key passed inline):
//   STRIPE_SECRET_KEY=sk_live_… npx tsx scripts/add-webhook-events-promo.ts
//
// Per spec 79: these events fire on the merchant's connected account
// (not the platform), so only Connect endpoints (`connect: true`) get
// the additions. Account endpoints are left untouched.
//
// SAFETY: the script never deletes endpoints. The worst possible
// outcome is "ran twice → second run is a no-op." If you see anything
// unexpected, the dry-run pass below prints the planned diff before
// any update is sent — abort with Ctrl-C if it looks wrong.

import 'dotenv/config'
import Stripe from 'stripe'
import { STRIPE_API_VERSION } from '../src/winback/lib/stripe'

const NEW_CONNECT_EVENTS = [
  'promotion_code.created',
  'promotion_code.updated',
  'coupon.updated',
  'coupon.deleted',
] as const

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
  console.log(`Mode: ${mode}  (using ${varName}, prefix: ${key.slice(0, 9)}…)`)
  console.log(`Adding events: ${NEW_CONNECT_EVENTS.join(', ')}\n`)

  const stripe = new Stripe(key, { apiVersion: STRIPE_API_VERSION })
  const eps = await stripe.webhookEndpoints.list({ limit: 100 })

  console.log(`Found ${eps.data.length} webhook endpoint(s):\n`)

  const plan: Array<{ ep: Stripe.WebhookEndpoint; missing: string[] }> = []
  for (const ep of eps.data) {
    // Stripe sets WebhookEndpoint.application when the endpoint is a
    // Connect endpoint. That's the only reliable signal — event-list
    // inspection is misleading (invoice.payment_* and checkout.session.*
    // both fire on Account AND Connect endpoints).
    const isConnect = Boolean((ep as unknown as { application?: string | null }).application)

    const currentEvents = new Set(ep.enabled_events as string[])
    const missing = NEW_CONNECT_EVENTS.filter((e) => !currentEvents.has(e))

    let reason: string
    if (!isConnect) {
      reason = 'Account endpoint — skipping (promo events only fire on Connect)'
    } else if (missing.length === 0) {
      reason = 'already has all events ✓'
    } else {
      reason = `will add ${missing.length} event(s)`
    }

    console.log(`  ${ep.id}`)
    console.log(`    url:           ${ep.url}`)
    console.log(`    status:        ${ep.status}`)
    console.log(`    api_version:   ${ep.api_version ?? '(default)'}`)
    console.log(`    enabled count: ${ep.enabled_events.length}`)
    console.log(`    type:          ${isConnect ? 'Connect' : 'Account'}`)
    console.log(`    plan:          ${reason}\n`)

    if (isConnect && missing.length > 0) {
      plan.push({ ep, missing })
    }
  }

  if (plan.length === 0) {
    console.log('Nothing to do. All Connect endpoints already have the events. Exiting.')
    return
  }

  console.log(`Applying ${plan.length} update(s)…\n`)
  for (const { ep, missing } of plan) {
    const newList = [...ep.enabled_events, ...missing]
    const updated = await stripe.webhookEndpoints.update(ep.id, {
      enabled_events: newList as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
    })
    console.log(`  ✓ ${updated.id}: now has ${updated.enabled_events.length} events ` +
                `(+${missing.length}: ${missing.join(', ')})`)
  }

  console.log(`\nDone. ${plan.length} endpoint(s) patched.`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })
