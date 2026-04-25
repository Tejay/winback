import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { billingRuns } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { processBillingRun } from '@/src/winback/lib/billing'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/actions/billing-retry
 * Body: { runId: string }
 *
 * Re-attempts a failed billing run. Loads the row by id, validates it's in
 * `failed` state (won't overwrite paid runs — UNIQUE constraint protects
 * against double-billing), then calls processBillingRun(customerId, period,
 * { isRetry: true }) which handles the rest.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const runId = String(body.runId ?? '').trim()
  if (!runId) {
    return NextResponse.json({ error: 'runId required' }, { status: 400 })
  }

  const [run] = await db
    .select({
      id: billingRuns.id,
      customerId: billingRuns.customerId,
      periodYyyymm: billingRuns.periodYyyymm,
      status: billingRuns.status,
    })
    .from(billingRuns)
    .where(eq(billingRuns.id, runId))
    .limit(1)

  if (!run) {
    return NextResponse.json({ error: 'billing run not found' }, { status: 404 })
  }
  if (run.status !== 'failed') {
    return NextResponse.json(
      { error: `cannot retry — run is in '${run.status}' state` }, { status: 409 },
    )
  }

  const result = await processBillingRun(run.customerId, run.periodYyyymm, { isRetry: true })

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId: run.customerId,
    properties: {
      action: 'billing_retry',
      runId: run.id,
      period: run.periodYyyymm,
      outcome: result.outcome,
      stripeInvoiceId: result.stripeInvoiceId,
    },
  })

  return NextResponse.json({ ok: result.outcome !== 'error', ...result })
}
