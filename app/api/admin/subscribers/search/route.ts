import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { findSubscribersByEmail } from '@/lib/admin/subscriber-search'

/**
 * GET /api/admin/subscribers/search?email=...&limit=100
 *
 * Cross-customer subscriber lookup — the complaint-triage primitive. Always
 * audit-logs as 'admin_subscriber_lookup' via findSubscribersByEmail.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { searchParams } = req.nextUrl
  const email = (searchParams.get('email') ?? '').trim()
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 })
  }
  const limit = Math.min(Number(searchParams.get('limit')) || 100, 500)

  const rows = await findSubscribersByEmail(email, {
    limit,
    adminUserId: auth.userId,
  })
  return NextResponse.json({ rows, total: rows.length })
}
