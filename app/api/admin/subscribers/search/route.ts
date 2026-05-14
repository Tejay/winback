import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  findSubscribersByEmail,
  findSubscribersByCustomer,
} from '@/lib/admin/subscriber-search'

/**
 * GET /api/admin/subscribers/search?email=...&limit=100
 * GET /api/admin/subscribers/search?customerId=...&limit=100   (Spec 69)
 *
 * Cross-customer subscriber lookup — the complaint-triage primitive. Always
 * audit-logs as 'admin_subscriber_lookup'. customerId wins when both are
 * present (it's the deeper filter).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { searchParams } = req.nextUrl
  const customerId = (searchParams.get('customerId') ?? '').trim()
  const email = (searchParams.get('email') ?? '').trim()
  const limit = Math.min(Number(searchParams.get('limit')) || 100, 500)

  if (customerId) {
    const rows = await findSubscribersByCustomer(customerId, {
      limit,
      adminUserId: auth.userId,
    })
    return NextResponse.json({ rows, total: rows.length, filteredBy: 'customerId' })
  }

  if (!email) {
    return NextResponse.json({ error: 'email or customerId required' }, { status: 400 })
  }

  const rows = await findSubscribersByEmail(email, {
    limit,
    adminUserId: auth.userId,
  })
  return NextResponse.json({ rows, total: rows.length, filteredBy: 'email' })
}
