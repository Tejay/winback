/**
 * Spec 77 — POST + DELETE /api/admin/customers/[id]/custom-rate tests.
 *
 * Covers:
 *   - admin auth gate (401/403)
 *   - body validation (cents bounds, confirm string)
 *   - happy path delegates to switchCustomerToFlatRate / revertCustomerToStandardRate
 *   - logs admin_action event with admin user + customer id
 *   - Stripe / lib errors return 500 with the message
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAdmin = vi.hoisted(() => vi.fn())
const mockSwitchCustomerToFlatRate = vi.hoisted(() => vi.fn())
const mockRevertCustomerToStandardRate = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSelect = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ requireAdmin: mockRequireAdmin }))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  users: { id: 'u.id', email: 'u.email' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

vi.mock('@/src/winback/lib/events', () => ({ logEvent: mockLogEvent }))

vi.mock('@/src/winback/lib/subscription', () => ({
  switchCustomerToFlatRate: mockSwitchCustomerToFlatRate,
  revertCustomerToStandardRate: mockRevertCustomerToStandardRate,
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}))

import { POST, DELETE } from '@/app/api/admin/customers/[id]/custom-rate/route'

function adminEmailLookup(email: string | null) {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(email ? [{ email }] : []),
      }),
    }),
  })
}

function makeReq(body: unknown, method: 'POST' | 'DELETE'): Request {
  return new Request('http://localhost/api/admin/customers/cust_1/custom-rate', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = () => ({ params: Promise.resolve({ id: 'cust_1' }) })

beforeEach(() => {
  vi.resetAllMocks()
})

describe('POST /api/admin/customers/[id]/custom-rate', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAdmin.mockResolvedValue({ error: 'Not signed in', status: 401 })
    const res = await POST(makeReq({ cents: 29900, confirm: 'SWITCH' }, 'POST'), params())
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin users', async () => {
    mockRequireAdmin.mockResolvedValue({ error: 'Admin only', status: 403 })
    const res = await POST(makeReq({ cents: 29900, confirm: 'SWITCH' }, 'POST'), params())
    expect(res.status).toBe(403)
  })

  it('rejects body missing cents', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    const res = await POST(makeReq({ confirm: 'SWITCH' }, 'POST'), params())
    expect(res.status).toBe(400)
  })

  it('rejects body missing/wrong confirm string', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    const res = await POST(makeReq({ cents: 29900, confirm: 'YES' }, 'POST'), params())
    expect(res.status).toBe(400)
  })

  it('rejects cents below 100 (use pilot for free comp)', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    const res = await POST(makeReq({ cents: 0, confirm: 'SWITCH' }, 'POST'), params())
    expect(res.status).toBe(400)
  })

  it('rejects cents above 999999 (sanity ceiling)', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    const res = await POST(makeReq({ cents: 1_500_000, confirm: 'SWITCH' }, 'POST'), params())
    expect(res.status).toBe(400)
  })

  it('happy path: calls switchCustomerToFlatRate with admin email + logs admin_action', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    adminEmailLookup('admin@winback.co')
    mockSwitchCustomerToFlatRate.mockResolvedValue({ priceUpdated: true })

    const res = await POST(makeReq({ cents: 29900, confirm: 'SWITCH' }, 'POST'), params())

    expect(res.status).toBe(200)
    expect(mockSwitchCustomerToFlatRate).toHaveBeenCalledWith(
      'cust_1',
      29900,
      { adminEmail: 'admin@winback.co' },
    )
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        action: 'flat_rate_assigned',
        customMonthlyCents: 29900,
        priceUpdatedOnStripe: true,
      }),
    }))
  })

  it('returns 500 when subscription helper throws', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    adminEmailLookup('admin@winback.co')
    mockSwitchCustomerToFlatRate.mockRejectedValue(new Error('Stripe down'))

    const res = await POST(makeReq({ cents: 29900, confirm: 'SWITCH' }, 'POST'), params())
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('Stripe down')
  })
})

describe('DELETE /api/admin/customers/[id]/custom-rate', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAdmin.mockResolvedValue({ error: 'Not signed in', status: 401 })
    const res = await DELETE(makeReq({ confirm: 'REVERT' }, 'DELETE'), params())
    expect(res.status).toBe(401)
  })

  it('rejects body without REVERT confirm', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    const res = await DELETE(makeReq({ confirm: 'YES' }, 'DELETE'), params())
    expect(res.status).toBe(400)
  })

  it('happy path: calls revertCustomerToStandardRate + logs admin_action', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    adminEmailLookup('admin@winback.co')
    mockRevertCustomerToStandardRate.mockResolvedValue({ priceUpdated: true })

    const res = await DELETE(makeReq({ confirm: 'REVERT' }, 'DELETE'), params())

    expect(res.status).toBe(200)
    expect(mockRevertCustomerToStandardRate).toHaveBeenCalledWith(
      'cust_1',
      { adminEmail: 'admin@winback.co' },
    )
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        action: 'flat_rate_cleared',
      }),
    }))
  })
})
