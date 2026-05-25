// Set up the sandbox webhook endpoints from scratch.
//
// Replaces the misconfigured `we_1TLLnOAt…` endpoint (which was pointing
// from sandbox to the prod URL — causing every sandbox event to fail at
// prod signature verification) with two correctly-configured endpoints
// pointing at the local ngrok URL.
//
// What this does:
//   1. Lists current webhook endpoints on the sandbox account
//   2. Deletes ALL of them (clean slate)
//   3. Creates a NEW Connect endpoint at NGROK_URL (events from connected
//      merchant accounts)
//   4. Creates a NEW Account endpoint at NGROK_URL (events on the
//      platform — our $99/mo subscription, card capture)
//   5. Both pinned to STRIPE_API_VERSION
//   6. Writes both signing secrets into .env.local (never printed)
//   7. Prints a summary with masked secrets
//
// After this runs, restart `npm run dev` (or it'll auto-restart on env
// change in dev) and stop the `stripe listen` background process — it's
// no longer needed.
//
// Run: npx tsx --env-file=.env.local scripts/setup-sandbox-webhook-endpoints.ts

import Stripe from 'stripe'
import { STRIPE_API_VERSION } from '../src/winback/lib/stripe'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const NGROK_URL = 'https://tejay.ngrok.app/api/stripe/webhook'
const ENV_PATH = join(__dirname, '..', '.env.local')

const CONNECT_EVENTS = [
  'customer.subscription.deleted',
  'customer.subscription.created',
  'checkout.session.completed',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  // Spec 79 — promo auto-sync. Webhook handlers in
  // app/api/stripe/webhook/route.ts mirror merchant Stripe edits into
  // wb_improvements so /reasons stays current without manual refresh.
  'promotion_code.created',
  'promotion_code.updated',
  'coupon.updated',
  'coupon.deleted',
]

const ACCOUNT_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.deleted',
  // Platform-side subscription updates → processPlatformSubscriptionUpdated
  // syncs billed_tier from the (possibly-changed) Price. Without this
  // event the handler only sees create/delete on the platform sub, which
  // misses mid-life tier changes via Stripe Customer Portal.
  'customer.subscription.updated',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  'invoice.paid',
]

function maskSecret(s: string): string {
  if (s.length < 12) return '<too-short>'
  return `${s.slice(0, 9)}…${s.slice(-4)}  (length=${s.length})`
}

function writeEnvVar(name: string, value: string): { line: number; quoted: boolean } {
  const env = readFileSync(ENV_PATH, 'utf8')
  const lines = env.split('\n')
  let foundLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${name}=`)) { foundLine = i; break }
  }
  if (foundLine === -1) {
    // Append at end
    lines.push(`${name}=${value}`)
    foundLine = lines.length - 1
    writeFileSync(ENV_PATH, lines.join('\n'))
    return { line: foundLine + 1, quoted: false }
  }
  const existing = lines[foundLine]
  const quoted = existing.includes('="')
  lines[foundLine] = quoted ? `${name}="${value}"` : `${name}=${value}`
  writeFileSync(ENV_PATH, lines.join('\n'))
  return { line: foundLine + 1, quoted }
}

async function main() {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: STRIPE_API_VERSION })

  console.log(`Target URL: ${NGROK_URL}`)
  console.log(`Target API version: ${STRIPE_API_VERSION}\n`)

  // 1) List current endpoints
  const existing = await stripe.webhookEndpoints.list({ limit: 100 })
  console.log(`[1/4] Found ${existing.data.length} existing endpoint(s):`)
  for (const e of existing.data) {
    console.log(`  ${e.id}  url=${e.url}  status=${e.status}  app=${e.application ?? 'none'}`)
  }

  // 2) Delete them all
  console.log(`\n[2/4] Deleting all existing endpoints...`)
  for (const e of existing.data) {
    await stripe.webhookEndpoints.del(e.id)
    console.log(`  deleted ${e.id}`)
  }

  // 3) Create Connect endpoint
  console.log(`\n[3/4] Creating Connect endpoint (events from connected accounts)`)
  const connectEp = await stripe.webhookEndpoints.create({
    url: NGROK_URL,
    enabled_events: CONNECT_EVENTS as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
    api_version: STRIPE_API_VERSION,
    connect: true,
    description: 'sandbox — Connect events (Spec 62, ngrok local-dev)',
  })
  console.log(`  ${connectEp.id}  events=${connectEp.enabled_events.length}  api_version=${connectEp.api_version}`)
  if (!connectEp.secret) {
    console.error('  ❌ no signing secret returned')
    process.exit(1)
  }

  // 4) Create Account (platform) endpoint
  console.log(`\n[4/4] Creating Account endpoint (events on the platform account)`)
  const accountEp = await stripe.webhookEndpoints.create({
    url: NGROK_URL,
    enabled_events: ACCOUNT_EVENTS as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
    api_version: STRIPE_API_VERSION,
    // connect: false (default) → events from this account, not from connected accounts
    description: 'sandbox — Account events (Spec 62, ngrok local-dev)',
  })
  console.log(`  ${accountEp.id}  events=${accountEp.enabled_events.length}  api_version=${accountEp.api_version}`)
  if (!accountEp.secret) {
    console.error('  ❌ no signing secret returned')
    process.exit(1)
  }

  // Write secrets into .env.local
  console.log(`\n[secrets] Writing both signing secrets into .env.local (values NOT printed)`)
  const c1 = writeEnvVar('STRIPE_WEBHOOK_SECRET', connectEp.secret)
  console.log(`  STRIPE_WEBHOOK_SECRET           (Connect)  → line ${c1.line}, ${c1.quoted ? 'quoted' : 'unquoted'}`)
  console.log(`     ${maskSecret(connectEp.secret)}`)
  const c2 = writeEnvVar('STRIPE_PLATFORM_WEBHOOK_SECRET', accountEp.secret)
  console.log(`  STRIPE_PLATFORM_WEBHOOK_SECRET  (Account)  → line ${c2.line}, ${c2.quoted ? 'quoted' : 'unquoted'}`)
  console.log(`     ${maskSecret(accountEp.secret)}`)

  console.log(`\n=== Done ===`)
  console.log(`Sandbox endpoints replaced. Next:`)
  console.log(`  1. Stop the \`stripe listen\` CLI process (no longer needed)`)
  console.log(`  2. Restart \`npm run dev\` to pick up the new env vars`)
  console.log(`  3. Run a Tier 1/2/3 test to verify webhooks flow through ngrok`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })
