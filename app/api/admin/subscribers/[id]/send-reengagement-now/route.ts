import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { processSubscriberForReengagement } from '@/src/winback/lib/reengagement-cron-v2'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 70 #4 — admin "Send re-engagement now" action.
 *
 * POST { confirm: "SEND" }
 *
 * Runs the full V2 match-and-send pipeline for ONE subscriber, bypassing
 * the 60-day cooldown but still respecting:
 *   - customer-level pause gates (win-back cohort, billing pause)
 *   - per-improvement-once uniqueness
 *   - pre-send sanity check
 *   - 9-month expiry wall (rejected upstream, see below)
 *
 * Three LLM calls fire on a typical run (classify-if-needed + match +
 * generate + sanity) so the merchant-facing cost is ~$0.006. The "SEND"
 * confirm string is the guard.
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
  if (String(body.confirm ?? '') !== 'SEND') {
    return NextResponse.json(
      { error: "confirm field must equal the literal string 'SEND'" },
      { status: 400 },
    )
  }

  const [sub] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, id))
    .limit(1)
  if (!sub) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  // 9-month wall — force-fire on a long-expired subscriber would be
  // creepy. Admin can revive via the force-status endpoint first if
  // they really want this.
  if (sub.reengagementExpiredAt) {
    return NextResponse.json(
      { error: 'Subscriber is past the 9-month re-engagement wall. Revive via force-status first.' },
      { status: 409 },
    )
  }

  const outcome = await processSubscriberForReengagement(sub, { bypassCooldown: true })

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId: sub.customerId,
    properties: {
      action: 'reengagement_force_sent',
      subscriberId: sub.id,
      outcome: outcome.kind,
      ...(outcome.kind === 'skipped' ? { reason: outcome.reason } : {}),
      ...(outcome.kind === 'emailed' ? { improvementId: outcome.improvementId } : {}),
      ...(outcome.kind === 'error' ? { errorMessage: outcome.errorMessage } : {}),
    },
  })

  return NextResponse.json({ ok: true, outcome })
}
