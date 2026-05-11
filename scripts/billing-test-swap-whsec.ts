// Swap STRIPE_WEBHOOK_SECRET in .env.local to the value `stripe listen`
// prints on startup. Reads /tmp/stripe-listen.log, finds the whsec_ value,
// rewrites .env.local in place. Never prints the secret.
//
// Run: npx tsx scripts/billing-test-swap-whsec.ts

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..')
const ENV_PATH = join(ROOT, '.env.local')
const STRIPE_LOG = '/tmp/stripe-listen.log'

function maskSecret(s: string) {
  if (s.length < 12) return '<too-short>'
  return s.slice(0, 6) + '...' + s.slice(-4)
}

const log = readFileSync(STRIPE_LOG, 'utf8')
// Strip ANSI color codes so the regex doesn't get confused
// eslint-disable-next-line no-control-regex
const clean = log.replace(/\[[0-9;]*m/g, '')
const m = clean.match(/whsec_[A-Za-z0-9]+/)
if (!m) {
  console.error('No whsec_ found in', STRIPE_LOG)
  process.exit(1)
}
const newSecret = m[0]
console.log(`Found CLI webhook secret: ${maskSecret(newSecret)}  (length=${newSecret.length})`)

const env = readFileSync(ENV_PATH, 'utf8')
const lines = env.split('\n')
let foundLine = -1
for (let i = 0; i < lines.length; i++) {
  if (lines[i].startsWith('STRIPE_WEBHOOK_SECRET=')) {
    foundLine = i
    break
  }
}
if (foundLine === -1) {
  console.error('STRIPE_WEBHOOK_SECRET= line not found in .env.local')
  process.exit(1)
}

// Preserve quoting style — if existing was quoted, quote the new value too
const existing = lines[foundLine]
const quoted = existing.includes('="')
lines[foundLine] = quoted
  ? `STRIPE_WEBHOOK_SECRET="${newSecret}"`
  : `STRIPE_WEBHOOK_SECRET=${newSecret}`

writeFileSync(ENV_PATH, lines.join('\n'))
console.log(`✓ STRIPE_WEBHOOK_SECRET updated in .env.local (line ${foundLine + 1}, ${quoted ? 'quoted' : 'unquoted'})`)
console.log(`✓ Other lines untouched (${lines.length} total)`)
