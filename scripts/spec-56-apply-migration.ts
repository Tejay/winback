// One-shot migration runner for Spec 56's 036 SQL file.
// Reads DATABASE_URL from env (via lib/db), applies via Drizzle's
// db.execute(sql.raw(...)).
// Run: npx tsx --env-file=.env.local scripts/spec-56-apply-migration.ts

import { readFileSync } from 'fs'
import { join } from 'path'
import { db } from '../lib/db'
import { sql } from 'drizzle-orm'

async function main() {
  const sqlText = readFileSync(
    join(__dirname, '..', 'src', 'winback', 'migrations', '036_unique_stripe_account_id.sql'),
    'utf8',
  )

  console.log('Applying migration 036_unique_stripe_account_id.sql...\n')

  // Split into statements; skip blank lines and pure-comment lines
  const stmts = sqlText
    .split(/;\s*\n/)
    .map(s => s.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim())
    .filter(s => s.length > 0)

  for (const stmt of stmts) {
    const firstLine = stmt.split('\n')[0]
    console.log(`> ${firstLine}${stmt.split('\n').length > 1 ? ' ...' : ''}`)
    await db.execute(sql.raw(stmt))
  }

  // Verify the index now exists
  const check = await db.execute(sql.raw(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = 'wb_customers'
      AND indexname = 'customers_stripe_account_id_unique'
  `))
  console.log('\n=== Verification ===')
  console.log(check)
}

main().then(() => process.exit(0)).catch((e) => { console.error('Migration FAILED:', e); process.exit(1) })
