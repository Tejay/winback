import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { sql } from 'drizzle-orm'

/**
 * Spec 76 — list of currently dead-lettered classifier rows.
 *
 * A row is dead-lettered when:
 *   - `classified_at IS NULL`  (never successfully classified)
 *   - `classify_attempts >= 3` (gave up after 3 attempts; Spec 72)
 *
 * Returns each stuck subscriber with enough context to triage (founder,
 * plan, MRR, attempts, last `classify_failed` error message) so the
 * admin drawer can render and act without per-row drill-down.
 *
 * Soft-capped at 100 rows. If the queue ever exceeds that, the catastrophe
 * is bigger than this surface is designed for — drop into the events log
 * and a SQL session.
 *
 * Auth: admin only. Read-only DB connection.
 */

export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  try {
    // Single query joining subscribers → customers → users for founder
    // context, with a LATERAL JOIN against wb_events to pull the most
    // recent classify_failed errorMessage for each row. LATERAL is the
    // cleanest way to do a per-row "most recent matching child" lookup
    // in Postgres — semantically a correlated subquery, but Postgres
    // can plan it efficiently.
    const result = await getDbReadOnly().execute(sql`
      SELECT
        s.id                          AS id,
        s.customer_id                 AS customer_id,
        s.email                       AS email,
        s.name                        AS name,
        s.plan_name                   AS plan_name,
        s.mrr_cents                   AS mrr_cents,
        s.classify_attempts           AS classify_attempts,
        s.updated_at                  AS updated_at,
        c.product_name                AS customer_product_name,
        u.email                       AS customer_email,
        last_err.msg                  AS last_error
      FROM wb_churned_subscribers s
      JOIN wb_customers c ON c.id = s.customer_id
      JOIN wb_users u     ON u.id = c.user_id
      LEFT JOIN LATERAL (
        SELECT properties->>'errorMessage' AS msg
        FROM wb_events
        WHERE name = 'classify_failed'
          AND properties->>'subscriberId' = s.id::text
        ORDER BY created_at DESC
        LIMIT 1
      ) last_err ON true
      WHERE s.classified_at IS NULL
        AND s.classify_attempts >= 3
      ORDER BY s.updated_at DESC
      LIMIT 100
    `)

    // drizzle execute() returns { rows: [...] } on neon-http.
    const rows = (result as { rows?: unknown[] }).rows ?? (result as unknown as unknown[])
    return NextResponse.json({ rows, total: Array.isArray(rows) ? rows.length : 0 })
  } catch (err) {
    console.error('[admin/classifier-dead-letter-list] failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list dead-letter rows' },
      { status: 500 },
    )
  }
}
