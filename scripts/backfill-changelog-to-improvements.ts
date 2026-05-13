// Spec 65 Phase 2 — one-shot backfill of existing customers.changelog_text
// blobs into the new wb_improvements per-entry model.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/backfill-changelog-to-improvements.ts
//
// Per CLAUDE.md, secrets stay out of argv — only DATABASE_URL is read
// from the env file. Run for prod by pulling prod env into a temp file
// and pointing the script at it via --env-file.
//
// IDEMPOTENT: skips any customer who already has at least one
// wb_improvements row. Safe to re-run.

import { db } from '../lib/db'
import { customers, improvements } from '../lib/schema'
import { eq, sql } from 'drizzle-orm'

const IMPORT_TITLE       = 'Imported changelog (review and update)'
const DESCRIPTION_MAX    = 500

async function main() {
  const all = await db
    .select({
      id:            customers.id,
      userId:        customers.userId,
      changelogText: customers.changelogText,
      createdAt:     customers.createdAt,
    })
    .from(customers)

  let migrated = 0
  let skipped  = 0
  let empty    = 0

  for (const c of all) {
    const text = (c.changelogText ?? '').trim()
    if (!text) { empty++; continue }

    // Skip if this customer already has any improvement
    const existing = await db.execute(sql.raw(
      `SELECT 1 FROM wb_improvements WHERE customer_id = '${c.id}' LIMIT 1`,
    ))
    if ((existing.rows ?? []).length > 0) { skipped++; continue }

    const description = text.length > DESCRIPTION_MAX
      ? text.slice(0, DESCRIPTION_MAX - 1) + '…'
      : text

    await db.insert(improvements).values({
      customerId:       c.id,
      title:            IMPORT_TITLE,
      description,
      dateShipped:      c.createdAt ?? new Date(),
      addressesPattern: null,
      preempted:        true,
    })

    migrated++
  }

  console.log(`✓ backfill complete: migrated=${migrated}, skipped=${skipped}, empty=${empty}`)
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
