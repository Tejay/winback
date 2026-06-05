import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { logEvent } from '@/src/winback/lib/events'
import { getSendingMode, SENDING_MODES, type SendingMode } from '@/src/winback/lib/sending-mode'

/**
 * POST /api/admin/actions/set-sending-mode
 * Body: { mode: 'live'|'allowlist'|'paused', confirm?: string }
 *
 * The global go-live safety switch. Logs an admin_action (action=
 * set_sending_mode) which is BOTH the source of truth getSendingMode reads
 * and the audit trail.
 *
 * Asymmetric friction so the dangerous direction can't be flipped by
 * accident, while the safe direction (kill) stays fast:
 *   - → paused    : no phrase (instant kill switch)
 *   - → allowlist : type "ALLOWLIST"
 *   - → live      : type "ENABLE LIVE SENDING"  (re-enables real subscriber emails)
 */
const CONFIRM_PHRASE: Partial<Record<SendingMode, string>> = {
  allowlist: 'ALLOWLIST',
  live: 'ENABLE LIVE SENDING',
}

export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const mode = String(body.mode ?? '').trim() as SendingMode
  const confirm = String(body.confirm ?? '')

  if (!(SENDING_MODES as readonly string[]).includes(mode)) {
    return NextResponse.json({ error: `invalid mode; expected one of ${SENDING_MODES.join(', ')}` }, { status: 400 })
  }

  const required = CONFIRM_PHRASE[mode]
  if (required && confirm !== required) {
    return NextResponse.json(
      { error: `confirmation required — type "${required}" to switch to ${mode}`, needsConfirm: required },
      { status: 400 },
    )
  }

  const previousMode = await getSendingMode()

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    properties: { action: 'set_sending_mode', mode, previousMode },
  })

  return NextResponse.json({ ok: true, mode, previousMode })
}
