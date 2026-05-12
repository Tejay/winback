// Spec 62 (Dashboard companion) — pin every Stripe webhook endpoint's
// `api_version` to STRIPE_API_VERSION via the Stripe API.
//
// Without this, code uses the pinned version for our outgoing API
// calls, but Stripe still delivers webhook events at the account's
// default version. The two can drift apart silently.
//
// Default: dry-run (lists current pins, doesn't change anything).
// Pass --apply to actually update.
//
// Run:
//   npx tsx --env-file=.env.local scripts/spec-62-pin-webhook-endpoints.ts           # dry-run
//   npx tsx --env-file=.env.local scripts/spec-62-pin-webhook-endpoints.ts --apply   # apply

import Stripe from 'stripe'
import { STRIPE_API_VERSION } from '../src/winback/lib/stripe'

const DRY = !process.argv.includes('--apply')

async function main() {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: STRIPE_API_VERSION,
  })

  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 })

  console.log(`Found ${endpoints.data.length} webhook endpoint(s). Target version: ${STRIPE_API_VERSION}`)
  console.log(`Mode: ${DRY ? 'DRY RUN (will not modify)' : 'APPLY'}\n`)

  let toUpdate = 0
  let alreadyPinned = 0
  let disabled = 0

  for (const e of endpoints.data) {
    const currentVersion = e.api_version ?? '(default)'
    const willChange = e.api_version !== STRIPE_API_VERSION
    const isDisabled = e.status === 'disabled'

    console.log(`${e.id}`)
    console.log(`  url=${e.url}`)
    console.log(`  application=${e.application ?? 'none (platform-direct)'}`)
    console.log(`  status=${e.status}`)
    console.log(`  current api_version=${currentVersion}`)

    if (isDisabled) {
      console.log(`  → skip: endpoint is disabled\n`)
      disabled++
      continue
    }

    if (!willChange) {
      console.log(`  → already pinned to ${STRIPE_API_VERSION}\n`)
      alreadyPinned++
      continue
    }

    toUpdate++
    if (DRY) {
      console.log(`  → would update: ${currentVersion} -> ${STRIPE_API_VERSION}\n`)
    } else {
      // Stripe API: webhookEndpoints.update only allows changing `description`,
      // `disabled`, `enabled_events`, `metadata`, `url`. To change api_version
      // we have to recreate the endpoint. Document and abort with a clear
      // message rather than guessing.
      //
      // Source: https://stripe.com/docs/api/webhook_endpoints/update
      // "Updates the webhook endpoint. You may edit the url, the list of
      //  enabled_events, and the status of your endpoint."
      console.log(`  ❌ Stripe API does NOT permit changing api_version on an existing endpoint.`)
      console.log(`     To pin: delete this endpoint, recreate with api_version=${STRIPE_API_VERSION}.`)
      console.log(`     (Or use the Stripe Dashboard — same underlying restriction; Dashboard hides`)
      console.log(`     the recreate-vs-update detail.)`)
      console.log()
    }
  }

  console.log(`---`)
  console.log(`Summary: ${endpoints.data.length} endpoint(s) — ${alreadyPinned} already pinned, ${toUpdate} would change, ${disabled} disabled (skipped)`)

  if (!DRY && toUpdate > 0) {
    console.log()
    console.log(`Manual recreate steps (per endpoint that needs pinning):`)
    console.log(`  1. Note the current url + enabled_events`)
    console.log(`  2. await stripe.webhookEndpoints.del('we_xxx')`)
    console.log(`  3. await stripe.webhookEndpoints.create({ url, enabled_events, api_version: '${STRIPE_API_VERSION}' })`)
    console.log(`  4. Capture the NEW signing secret returned by create() — update`)
    console.log(`     STRIPE_WEBHOOK_SECRET in Vercel env (production + preview), redeploy.`)
    console.log()
    console.log(`This script intentionally stops short of doing the recreate automatically`)
    console.log(`because it requires rotating the signing secret — a separate, sensitive operation.`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })
