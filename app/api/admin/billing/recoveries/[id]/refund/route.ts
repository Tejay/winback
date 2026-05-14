import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveries } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { refundPerformanceFee } from '@/src/winback/lib/performance-fee'
import { logEvent } from '@/src/winback/lib/events'

const REFUND_WINDOW_DAYS = 14

/**
 * Spec 67 — admin refund of a 1× MRR performance fee.
 *
 * POST { confirm: "REFUND" }
 *
 * Wraps refundPerformanceFee() (which already handles the three Stripe
 * branches: delete-item / credit-note / noop, and is idempotent). The
 * audit-log entry captures whether the refund was inside or outside the
 * 14-day window so we can review out-of-policy refunds later.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const confirm = String(body.confirm ?? '')
  if (confirm !== 'REFUND') {
    return NextResponse.json(
      { error: "confirm field must equal the literal string 'REFUND'" },
      { status: 400 },
    )
  }

  const [rec] = await db
    .select({
      id: recoveries.id,
      customerId: recoveries.customerId,
      chargedAt: recoveries.perfFeeChargedAt,
      refundedAt: recoveries.perfFeeRefundedAt,
    })
    .from(recoveries)
    .where(eq(recoveries.id, id))
    .limit(1)

  if (!rec) {
    return NextResponse.json({ error: 'recovery not found' }, { status: 404 })
  }

  const cutoff = Date.now() - REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const outsideWindow = !!rec.chargedAt && rec.chargedAt.getTime() < cutoff

  let result: Awaited<ReturnType<typeof refundPerformanceFee>>
  try {
    result = await refundPerformanceFee(id)
  } catch (err) {
    await logEvent({
      name: 'admin_action',
      userId: auth.userId,
      customerId: rec.customerId,
      properties: {
        action: 'perf_fee_refunded',
        recoveryId: id,
        outcome: 'error',
        outsideWindow,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'refund failed' },
      { status: 500 },
    )
  }

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId: rec.customerId,
    properties: {
      action: 'perf_fee_refunded',
      recoveryId: id,
      method: result.method,
      outsideWindow,
    },
  })

  return NextResponse.json({ ok: true, method: result.method })
}
