#!/usr/bin/env tsx
/**
 * Data Subject Request handler — Tier 1 manual tool.
 *
 * Usage:
 *   npx tsx scripts/dsr.ts export <email>
 *   npx tsx scripts/dsr.ts delete <email>
 *
 * `export` prints a JSON bundle of every row we hold for that email across
 * wb_churned_subscribers + wb_emails_sent. Attach to the reply to the data subject.
 *
 * `delete` deletes the subscriber rows (cascades to emails_sent). Use for Art. 17
 * erasure requests. Requires a typed confirmation to guard against mistakes.
 */
import 'dotenv/config'
import { db } from '../lib/db'
import { churnedSubscribers, emailsSent } from '../lib/schema'
import { eq, inArray } from 'drizzle-orm'
import * as readline from 'node:readline/promises'

async function main() {
  const [cmd, email] = process.argv.slice(2)
  if (!cmd || !email) {
    console.error('Usage: npx tsx scripts/dsr.ts <export|delete> <email>')
    process.exit(1)
  }

  const subs = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.email, email))

  if (subs.length === 0) {
    console.log(JSON.stringify({ email, found: false, records: [] }, null, 2))
    return
  }

  const ids = subs.map((s) => s.id)
  const emails = await db
    .select()
    .from(emailsSent)
    .where(inArray(emailsSent.subscriberId, ids))

  if (cmd === 'export') {
    console.log(JSON.stringify({ email, subscribers: subs, emails }, null, 2))
    return
  }

  if (cmd === 'delete') {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(
      `About to delete ${subs.length} subscriber row(s) and ${emails.length} email row(s) for ${email}. Type DELETE to confirm: `
    )
    rl.close()
    if (answer !== 'DELETE') {
      console.log('Aborted.')
      process.exit(1)
    }
    await db.delete(emailsSent).where(inArray(emailsSent.subscriberId, ids))
    await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, ids))
    console.log(`Deleted ${subs.length} subscriber + ${emails.length} email rows for ${email}`)
    return
  }

  console.error(`Unknown command: ${cmd}`)
  process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
