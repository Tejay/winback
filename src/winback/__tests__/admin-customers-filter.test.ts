/**
 * Spec 30 — `/api/admin/customers?filter=stuck_on_signup` filter test.
 *
 * Verifies:
 *  - filter=stuck_on_signup adds an `is null` clause on stripeAccountId
 *  - filter + q stack via `and(...)` (both predicates active)
 *  - unknown filter values are ignored
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockGetDbReadOnly = vi.hoisted(() =>
  vi.fn(() => ({ select: mockSelect })),
)
const mockRequireAdmin = vi.hoisted(() => vi.fn())

const isNullSentinel = { __isNull: true }
const orSentinel     = { __or: true }
const andSentinel    = { __and: true }

const mockIsNull = vi.hoisted(() => vi.fn(() => ({ __isNull: true })))
const mockOr     = vi.hoisted(() => vi.fn(() => ({ __or: true })))
const mockAnd    = vi.hoisted(() => vi.fn((...args: unknown[]) => ({ __and: true, args })))

vi.mock('@/lib/db', () => ({
  db:            { select: vi.fn() },
  getDbReadOnly: mockGetDbReadOnly,
}))

vi.mock('@/lib/auth', () => ({
  requireAdmin: mockRequireAdmin,
}))

vi.mock('@/lib/schema', () => ({
  customers:          { id: 'c_id', userId: 'c_uid', founderName: 'fname', productName: 'pname', plan: 'plan', stripeAccessToken: 'stripe_at', stripeAccountId: 'stripe_aid', pausedAt: 'paused', createdAt: 'created' },
  users:              { id: 'u_id', email: 'u_email' },
  churnedSubscribers: { customerId: 'cs_cid' },
  recoveries:         { customerId: 'r_cid' },
  wbEvents:           { customerId: 'e_cid', createdAt: 'e_created' },
}))

vi.mock('drizzle-orm', () => ({
  eq:    vi.fn(),
  ilike: vi.fn(),
  or:    mockOr,
  and:   mockAnd,
  isNull: mockIsNull,
  desc:  vi.fn(),
  sql:   Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values }),
    { raw: (s: string) => s },
  ),
}))

import { GET } from '../../../app/api/admin/customers/route'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
  mockIsNull.mockReturnValue(isNullSentinel)
  mockOr.mockReturnValue(orSentinel)
  mockAnd.mockImplementation((...args: unknown[]) => ({ __and: true, args }))

  // Capture the `where` argument by chaining.
  const whereSpy = vi.fn()
  ;(whereSpy as unknown as { lastArg: unknown }).lastArg = undefined
  whereSpy.mockImplementation((arg) => {
    ;(whereSpy as unknown as { lastArg: unknown }).lastArg = arg
    return {
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
      }),
    }
  })
  mockSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: whereSpy,
      }),
    }),
  })
  // Stash for assertions
  ;(globalThis as unknown as { __whereSpy: unknown }).__whereSpy = whereSpy
})

async function makeReq(url: string) {
  const { NextRequest } = await import('next/server')
  return new NextRequest(url)
}

function whereLastArg(): unknown {
  return ((globalThis as unknown as { __whereSpy: { lastArg: unknown } }).__whereSpy).lastArg
}

describe('GET /api/admin/customers — filter=stuck_on_signup', () => {
  it('passes a single isNull(stripeAccountId) clause when only filter is set', async () => {
    await GET(await makeReq('http://localhost/api/admin/customers?filter=stuck_on_signup'))
    expect(mockIsNull).toHaveBeenCalledWith('stripe_aid')
    expect(mockAnd).toHaveBeenCalledTimes(1)
    // and(...) called with exactly one arg (the isNull sentinel)
    const args = (mockAnd.mock.calls[0] ?? [])
    expect(args).toEqual([isNullSentinel])
  })

  it('stacks q and filter via and(orClause, isNullClause)', async () => {
    await GET(await makeReq('http://localhost/api/admin/customers?q=acme&filter=stuck_on_signup'))
    expect(mockOr).toHaveBeenCalled()
    expect(mockIsNull).toHaveBeenCalledWith('stripe_aid')
    expect(mockAnd).toHaveBeenCalledTimes(1)
    const args = (mockAnd.mock.calls[0] ?? [])
    expect(args).toEqual([orSentinel, isNullSentinel])
  })

  it('ignores an unknown filter value (no isNull clause added)', async () => {
    await GET(await makeReq('http://localhost/api/admin/customers?filter=garbage'))
    expect(mockIsNull).not.toHaveBeenCalled()
    // No q either → filters array is empty, where(undefined) is passed,
    // and(...) is NOT called.
    expect(mockAnd).not.toHaveBeenCalled()
  })

  it('returns 401-style error when requireAdmin denies', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Not signed in', status: 401 })
    const res = await GET(await makeReq('http://localhost/api/admin/customers?filter=stuck_on_signup'))
    expect(res.status).toBe(401)
    expect(mockSelect).not.toHaveBeenCalled()
  })
})
