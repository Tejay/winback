import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  findSubscribersByEmail,
  findSubscribersByCustomer,
  findSubscribersByCohort,
  type SubscriberCohort,
} from '@/lib/admin/subscriber-search'

const VALID_COHORTS: readonly SubscriberCohort[] = ['drain_paused', 'unclassified']

/**
 * GET /api/admin/subscribers/search?email=...&limit=100
 * GET /api/admin/subscribers/search?customerId=...&limit=100   (Spec 69)
 * GET /api/admin/subscribers/search?cohort=drain_paused|unclassified   (PR 2)
 *
 * Cross-customer subscriber lookup — the complaint-triage primitive.
 * Precedence: customerId > cohort > email. Always audit-logs as
 * 'admin_subscriber_lookup'.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { searchParams } = req.nextUrl
  const customerId = (searchParams.get('customerId') ?? '').trim()
  const cohort     = (searchParams.get('cohort')     ?? '').trim()
  const email      = (searchParams.get('email')      ?? '').trim()
  const limit = Math.min(Number(searchParams.get('limit')) || 100, 500)

  if (customerId) {
    const rows = await findSubscribersByCustomer(customerId, {
      limit,
      adminUserId: auth.userId,
    })
    return NextResponse.json({ rows, total: rows.length, filteredBy: 'customerId' })
  }

  if (cohort) {
    if (!VALID_COHORTS.includes(cohort as SubscriberCohort)) {
      return NextResponse.json(
        { error: `invalid cohort '${cohort}'; expected one of: ${VALID_COHORTS.join(', ')}` },
        { status: 400 },
      )
    }
    const rows = await findSubscribersByCohort(cohort as SubscriberCohort, {
      limit,
      adminUserId: auth.userId,
    })
    return NextResponse.json({ rows, total: rows.length, filteredBy: 'cohort', cohort })
  }

  if (!email) {
    return NextResponse.json({ error: 'email, customerId, or cohort required' }, { status: 400 })
  }

  const rows = await findSubscribersByEmail(email, {
    limit,
    adminUserId: auth.userId,
  })
  return NextResponse.json({ rows, total: rows.length, filteredBy: 'email' })
}
