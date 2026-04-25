import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { buildInspectorPayload } from '@/lib/admin/inspector-queries'

/**
 * GET /api/admin/subscribers/[id]
 *
 * Returns the full inspector payload for one real subscriber: identity,
 * customer context, signals at churn, latest classification, all email
 * turns (with bodies post-spec-27), and outcome events.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const payload = await buildInspectorPayload(id)
  if (!payload.subscriber) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }
  return NextResponse.json(payload)
}
