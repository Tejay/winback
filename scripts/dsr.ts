#!/usr/bin/env tsx
/**
 * Data Subject Request handler — Tier 1 manual tool.
 *
 * Usage:
 *   npx tsx scripts/dsr.ts export <email>
 *   npx tsx scripts/dsr.ts delete <email>
 *
 * `export` prints a JSON bundle of every row we hold for that email across
 * wb_churned_subscribers + wb_emails_sent. Attach to the reply to the data
 * subject.
 *
 * `delete` deletes the subscriber rows (cascades to emails_sent). Use for
 * Art. 17 erasure requests. Requires a typed confirmation to guard against
 * mistakes.
 *
 * The actual queries live in lib/dsr.ts so the admin UI (spec 25) and this
 * CLI share one implementation.
 */
import 'dotenv/config'
import * as readline from 'node:readline/promises'
import { exportByEmail, deleteByEmail } from '../lib/dsr'

async function main() {
  const [cmd, email] = process.argv.slice(2)
  if (!cmd || !email) {
    console.error('Usage: npx tsx scripts/dsr.ts <export|delete> <email>')
    process.exit(1)
  }

  if (cmd === 'export') {
    const bundle = await exportByEmail(email)
    console.log(JSON.stringify(bundle, null, 2))
    return
  }

  if (cmd === 'delete') {
    const bundle = await exportByEmail(email)
    if (!bundle.found) {
      console.log(`No rows found for ${email}.`)
      return
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(
      `About to delete ${bundle.subscribers.length} subscriber row(s) and ${bundle.emails.length} email row(s) for ${email}. Type DELETE to confirm: `,
    )
    rl.close()
    if (answer !== 'DELETE') {
      console.log('Aborted.')
      process.exit(1)
    }
    const result = await deleteByEmail(email)
    console.log(
      `Deleted ${result.deletedSubscribers} subscriber + ${result.deletedEmails} email rows for ${email}`,
    )
    return
  }

  console.error(`Unknown command: ${cmd}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
