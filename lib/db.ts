import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

const sql = neon(process.env.DATABASE_URL)
export const db = drizzle(sql, { schema })

// Spec 25 — Read-only DB connection for /admin reads.
//
// The Postgres role behind DATABASE_URL_READONLY has SELECT only on wb_*
// tables, with statement_timeout = 5s set at the role level. This is the
// central guardrail against the "missing WHERE clause in unscoped admin
// code" failure mode: the only way an admin endpoint can mutate data is
// to explicitly opt into the privileged `db` instance (which forces a
// code-review beat). See specs/25-admin-dashboard.md for rationale.
//
// Lazy-initialised via a getter so module load doesn't blow up in
// environments where the env var isn't set (local dev, tests, preview
// deploys before the role is provisioned). Mirrors the existing
// serverless-safe pattern in CLAUDE.md.

type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>

let _dbReadOnly: DrizzleClient | null = null

export function getDbReadOnly(): DrizzleClient {
  if (_dbReadOnly) return _dbReadOnly
  const url = process.env.DATABASE_URL_READONLY
  if (!url) {
    throw new Error(
      'DATABASE_URL_READONLY is not set — provision the read-only Neon role and add the env var. See specs/25-admin-dashboard.md.',
    )
  }
  _dbReadOnly = drizzle(neon(url), { schema })
  return _dbReadOnly
}
