import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { deleteBySubscriberId, deleteByEmail } from '@/lib/dsr'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/actions/dsr-delete
 *
 * Hard-delete for GDPR Art. 17 erasure requests. Two modes:
 *   { subscriberId, confirm: 'DELETE' }  — single row across this customer
 *   { email,        confirm: 'DELETE' }  — every row matching email across all customers
 *
 * Requires the literal string 'DELETE' in `confirm` to guard against
 * accidental fire from a click-fatigued admin (mirrors the CLI prompt).
 *
 * Cascades email rows via the existing FK. Logs the action to wb_events
 * so the audit trail survives the data deletion.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const confirm = String(body.confirm ?? '')
  if (confirm !== 'DELETE') {
    return NextResponse.json(
      { error: "confirm field must equal the literal string 'DELETE'" },
      { status: 400 },
    )
  }
  const subscriberId = body.subscriberId ? String(body.subscriberId) : null
  const email = body.email ? String(body.email) : null
  if (!subscriberId && !email) {
    return NextResponse.json(
      { error: 'one of subscriberId or email required' }, { status: 400 },
    )
  }

  // Audit BEFORE the delete so we don't lose the trail if the delete cascades
  // wipe the related rows we'd want to reference.
  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    properties: {
      action: 'dsr_delete',
      mode: subscriberId ? 'by_subscriber_id' : 'by_email',
      subscriberId,
      email,
    },
  })

  const result = subscriberId
    ? await deleteBySubscriberId(subscriberId)
    : await deleteByEmail(email!)

  return NextResponse.json({ ok: true, ...result })
}
