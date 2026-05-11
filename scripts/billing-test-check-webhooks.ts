// Diagnostic: what webhook endpoints does Stripe have configured?
// Lists both platform-account endpoints and Connect-application endpoints.
// Read-only.
// Run: npx tsx --env-file=.env.local scripts/billing-test-check-webhooks.ts

import Stripe from 'stripe'

async function main() {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

  console.log('=== Platform-account webhook endpoints ===')
  const endpoints = await stripe.webhookEndpoints.list({ limit: 20 })
  for (const e of endpoints.data) {
    console.log(`  ${e.id}`)
    console.log(`    url=${e.url}`)
    console.log(`    status=${e.status}  api_version=${e.api_version ?? '(default)'}`)
    console.log(`    enabled_events=${e.enabled_events.length === 1 && e.enabled_events[0] === '*' ? '*' : e.enabled_events.join(',').slice(0, 200)}`)
    console.log(`    application=${e.application ?? 'none (platform-account)'}`)
    console.log(`    metadata=${JSON.stringify(e.metadata)}`)
    console.log()
  }

  console.log('=== Connect webhook endpoints (via Connect API) ===')
  // Connect webhooks are listed separately. They have a non-null `application`
  // field corresponding to the Connect application ID.
  if (process.env.STRIPE_CLIENT_ID) {
    console.log(`  STRIPE_CLIENT_ID=${process.env.STRIPE_CLIENT_ID}`)
    // Filter: endpoints associated with this Connect app
    const connectScoped = endpoints.data.filter(e => e.application === process.env.STRIPE_CLIENT_ID)
    console.log(`  found ${connectScoped.length} Connect-scoped endpoint(s) above`)
  } else {
    console.log('  STRIPE_CLIENT_ID not set')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
