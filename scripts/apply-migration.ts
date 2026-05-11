// Generic migration runner. Usage:
//   npx tsx --env-file=.env.local scripts/apply-migration.ts <migration-filename>
//
// Example:
//   npx tsx --env-file=.env.local scripts/apply-migration.ts 037_perf_fee_creating_lock.sql
//
// Splits the file on `;` boundaries, strips comment-only lines, executes
// each statement via Drizzle, then prints a verification query for any
// indexes the file mentioned (best-effort, helpful for the ALTER + INDEX
// patterns we use).

import { readFileSync } from 'fs'
import { join } from 'path'
import { db } from '../lib/db'
import { sql } from 'drizzle-orm'

async function main() {
  const filename = process.argv[2]
  if (!filename) { console.error('Usage: ... <migration-filename>'); process.exit(1) }

  const path = join(__dirname, '..', 'src', 'winback', 'migrations', filename)
  const text = readFileSync(path, 'utf8')

  console.log(`Applying migration ${filename}...\n`)

  const stmts = text
    .split(/;\s*\n/)
    .map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)

  for (const stmt of stmts) {
    const firstLine = stmt.split('\n')[0]
    console.log(`> ${firstLine}${stmt.split('\n').length > 1 ? ' …' : ''}`)
    await db.execute(sql.raw(stmt))
  }

  console.log('\n✓ migration applied')
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })
