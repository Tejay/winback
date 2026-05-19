// Toggle the Resend "dev" webhook on / off.
//
// Background: there are two Resend webhooks subscribed to email.received —
// the production one (https://winbackflow.co/api/email/inbound) and a
// dev one (https://tejay.ngrok.app/api/email/inbound). Resend fans every
// inbound out to both. Each environment's handler verifies subscribers
// against its own Neon branch — whichever branch owns the subscriber
// processes the reply; the other env writes a harmless
// `subscriber_not_found` row and returns 200.
//
// To avoid wasting Resend retries on a dev tunnel that isn't always up,
// the dev webhook starts disabled. Flip it on before a testing session,
// flip it off after.
//
// Usage:
//   npm run dev:webhook:on    # enable dev webhook (call this before testing)
//   npm run dev:webhook:off   # disable it (call this after)
//   npm run dev:webhook       # show current status
//
// Required env (in .env.local):
//   RESEND_API_KEY           workspace API key
//   RESEND_DEV_WEBHOOK_ID    the dev webhook's id (returned by Resend at creation)

import 'dotenv/config'

const RESEND_API_KEY        = process.env.RESEND_API_KEY
const RESEND_DEV_WEBHOOK_ID = process.env.RESEND_DEV_WEBHOOK_ID

if (!RESEND_API_KEY)        throw new Error('RESEND_API_KEY is not set')
if (!RESEND_DEV_WEBHOOK_ID) throw new Error('RESEND_DEV_WEBHOOK_ID is not set')

const action = (process.argv[2] ?? 'status').toLowerCase()

async function get(): Promise<{ status: string; endpoint: string }> {
  const res = await fetch(`https://api.resend.com/webhooks/${RESEND_DEV_WEBHOOK_ID}`, {
    headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
  })
  if (!res.ok) throw new Error(`Resend GET failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function patch(status: 'enabled' | 'disabled'): Promise<void> {
  const res = await fetch(`https://api.resend.com/webhooks/${RESEND_DEV_WEBHOOK_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization:  `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(`Resend PATCH failed: ${res.status} ${await res.text()}`)
}

async function main(): Promise<void> {
  if (action === 'on' || action === 'enable') {
    await patch('enabled')
    const w = await get()
    console.log(`✓ dev webhook ENABLED  →  ${w.endpoint}`)
    console.log(`  ngrok needs to be up for Resend deliveries to land`)
  } else if (action === 'off' || action === 'disable') {
    await patch('disabled')
    const w = await get()
    console.log(`✓ dev webhook DISABLED  (${w.endpoint})`)
    console.log(`  Resend will skip this webhook on inbound emails`)
  } else {
    const w = await get()
    console.log(`dev webhook ${w.status === 'enabled' ? '🟢 ENABLED' : '⚪ disabled'}`)
    console.log(`  endpoint: ${w.endpoint}`)
    console.log()
    console.log(`Commands:`)
    console.log(`  npm run dev:webhook:on     enable (start of testing)`)
    console.log(`  npm run dev:webhook:off    disable (end of testing)`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
