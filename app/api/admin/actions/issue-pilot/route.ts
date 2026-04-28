import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { logEvent } from '@/src/winback/lib/events'
import {
  countPilotSlotsUsed,
  issuePilotToken,
  PILOT_CAP,
} from '@/src/winback/lib/pilot'

/**
 * POST /api/admin/actions/issue-pilot
 * Body: { note?: string }
 *
 * Spec 31 — Issues a single-use pilot signup URL. The combined count of
 * (active pilots + unused unexpired tokens) is hard-capped at PILOT_CAP
 * (10). A freshly-issued token holds a slot until the founder redeems it,
 * the 14-day TTL expires, or someone manually marks it used.
 *
 * The cap-check is "fetch then insert" — there's a tiny race if two admins
 * click simultaneously at slot 9. Spec 31 §9 documents this: accepted, not
 * mitigated for v1.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const body = await req.json().catch(() => ({}))
  const note = typeof body.note === 'string' && body.note.trim().length > 0
    ? body.note.trim().slice(0, 200)
    : null

  const slotsUsed = await countPilotSlotsUsed()
  if (slotsUsed >= PILOT_CAP) {
    return NextResponse.json(
      { error: `Pilot cap reached (${slotsUsed}/${PILOT_CAP}).` },
      { status: 409 },
    )
  }

  const { rawToken, tokenId, expiresAt } = await issuePilotToken({
    note,
    createdByUserId: auth.userId,
  })

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  const url = `${base}/register?pilotToken=${encodeURIComponent(rawToken)}`

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    properties: {
      action: 'issue_pilot',
      tokenId,
      note,
      expiresAt: expiresAt.toISOString(),
    },
  })

  return NextResponse.json({ url, tokenId, expiresAt: expiresAt.toISOString() })
}
