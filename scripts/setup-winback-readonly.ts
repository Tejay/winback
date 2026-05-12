// Interactive setup for the winback_readonly Postgres role.
//
// Why: /admin uses DATABASE_URL_READONLY for SELECTs (spec 25). If that
// role is missing or its grants drift, /admin breaks with "Failed query"
// errors. This script idempotently creates the role + grants + 5s
// statement_timeout in one shot.
//
// USAGE
//   npx tsx scripts/setup-winback-readonly.ts dev     # dev Neon project
//   npx tsx scripts/setup-winback-readonly.ts prod    # prod Neon project
//
// FLOW
//   1. You paste the primary Neon URL when prompted. This must be the
//      owner / project-admin URL (CREATE ROLE permission). Grab it from
//      Neon Console → your project → Connection details → role with
//      "Owner" privilege.
//   2. The script generates a strong password, creates the role,
//      grants SELECT on every wb_* table, sets default privileges, and
//      sets statement_timeout=5s.
//   3. The script writes the resulting DATABASE_URL_READONLY to a file
//      in /tmp (mode 0600). It is NEVER echoed to stdout, so it never
//      leaks to chat / screen recordings.
//   4. Tell Claude the file path. Claude can pipe it into
//      `vercel env add` (prod) or print a one-liner for you to update
//      `.env.local` (dev) without ever reading the URL into chat.
//
// SAFETY
// - The admin URL you paste only goes into Node's stdin — never argv,
//   never process listings.
// - The generated readonly URL is written to /tmp with mode 0600 and
//   nothing prints it to stdout.
// - Re-running the script rotates the password.

import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { sql } from 'drizzle-orm'
import { createInterface } from 'readline'
import { randomBytes } from 'crypto'
import { writeFileSync } from 'fs'
import { stdin as input, stdout as output } from 'process'

function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input, output })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main() {
  const envLabel = (process.argv[2] || '').toLowerCase()
  if (envLabel !== 'dev' && envLabel !== 'prod') {
    console.error('Usage: npx tsx scripts/setup-winback-readonly.ts <dev|prod>')
    process.exit(1)
  }

  console.log(`\n=== winback_readonly setup — ${envLabel} ===\n`)
  console.log(`Paste the PRIMARY Neon URL for the ${envLabel} project.`)
  console.log(`Must be an owner/admin role with CREATE ROLE permission.`)
  console.log(`Format: postgresql://owner:password@host/dbname?sslmode=require\n`)

  const adminUrl = await ask('Primary URL: ')
  if (!/^postgres(?:ql)?:\/\//i.test(adminUrl)) {
    console.error('That doesn\'t look like a postgres URL. Exiting.')
    process.exit(1)
  }

  let parsed: URL
  try {
    parsed = new URL(adminUrl)
  } catch {
    console.error('Could not parse URL. Exiting.')
    process.exit(1)
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    console.error('URL is missing host or database name. Exiting.')
    process.exit(1)
  }

  // Strong password, URL-safe (alphanumeric only after stripping b64 specials).
  const password = randomBytes(24).toString('base64')
    .replace(/[+/=]/g, '')
    .slice(0, 32)
  const escaped = password.replace(/'/g, "''")  // SQL-escape single quotes (none in our charset, defensive)

  console.log('\nConnecting…')
  const db = drizzle(neon(adminUrl))

  // Each step is one HTTP call. neon-http supports DO blocks fine.
  const steps: Array<{ label: string; sql: string }> = [
    {
      label: 'create or rotate winback_readonly role',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'winback_readonly') THEN
          EXECUTE 'CREATE ROLE winback_readonly WITH LOGIN PASSWORD ''${escaped}''';
        ELSE
          EXECUTE 'ALTER ROLE winback_readonly WITH PASSWORD ''${escaped}''';
        END IF;
      END $$`,
    },
    {
      label: 'grant CONNECT on database',
      sql: `DO $$ BEGIN
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO winback_readonly', current_database());
      END $$`,
    },
    {
      label: 'grant USAGE on schema public',
      sql: `GRANT USAGE ON SCHEMA public TO winback_readonly`,
    },
    {
      label: 'grant SELECT on every existing wb_* table',
      sql: `DO $$
        DECLARE t text;
        BEGIN
          FOR t IN
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name LIKE 'wb_%'
          LOOP
            EXECUTE format('GRANT SELECT ON public.%I TO winback_readonly', t);
          END LOOP;
        END $$`,
    },
    {
      label: 'set default privileges so future wb_* tables auto-grant',
      sql: `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO winback_readonly`,
    },
    {
      label: 'set statement_timeout = 5s on the role',
      sql: `ALTER ROLE winback_readonly SET statement_timeout = '5s'`,
    },
  ]

  for (const step of steps) {
    process.stdout.write(`  ${step.label} … `)
    await db.execute(sql.raw(step.sql))
    console.log('ok')
  }

  // Verify how many tables the role can now SELECT.
  const verify = await db.execute(sql.raw(`
    SELECT count(*)::int AS n
    FROM information_schema.table_privileges
    WHERE grantee = 'winback_readonly'
      AND privilege_type = 'SELECT'
      AND table_name LIKE 'wb_%'
  `))
  const n = ((verify.rows ?? [])[0] as { n?: number } | undefined)?.n ?? 0
  console.log(`\n✓ winback_readonly now has SELECT on ${n} wb_* table(s)`)

  // Build the readonly URL — password chars are URL-safe so no encoding needed.
  const roUrl = `postgresql://winback_readonly:${password}@${parsed.host}${parsed.pathname}${parsed.search}`

  // Write to /tmp with mode 0600. Never echoed to stdout.
  const outPath = `/tmp/winback-readonly-${envLabel}.url`
  writeFileSync(outPath, roUrl, { mode: 0o600 })
  console.log(`\n✓ DATABASE_URL_READONLY for ${envLabel} written to:\n  ${outPath}\n`)
  console.log(`Next: tell Claude. It will read the file and set the env var without echoing the URL.`)
  console.log(`Delete the temp file once Claude confirms:`)
  console.log(`  rm ${outPath}`)
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
