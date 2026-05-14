/**
 * Spec 67 — POST /api/admin/billing/recoveries/[id]/refund tests.
 *
 * Verifies:
 *  - requireAdmin gate
 *  - typed-confirm "REFUND" gate
 *  - 404 when recovery not found
 *  - happy path: calls refundPerformanceFee, logs admin_action with method
 *  - error path: still logs admin_action with outcome=error
 *  - outsideWindow flag is true when chargedAt is > 14 days ago
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAdmin = vi.hoisted(() => vi.fn())
const mockSelect       = vi.hoisted(() => vi.fn())
const mockRefund       = vi.hoisted(() => vi.fn())
const mockLogEvent     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/auth', () => ({
  requireAdmin: mockRequireAdmin,
}))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  recoveries: {
    id: 'id',
    customerId: 'customer_id',
    perfFeeChargedAt: 'perf_fee_charged_at',
    perfFeeRefundedAt: 'perf_fee_refunded_at',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

vi.mock('@/src/winback/lib/performance-fee', () => ({
  refundPerformanceFee: mockRefund,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/admin/billing/recoveries/[id]/refund/route'

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/billing/recoveries/rec_1/refund', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const params = { params: Promise.resolve({ id: 'rec_1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
})

describe('POST /api/admin/billing/recoveries/[id]/refund', () => {
  it('rejects when requireAdmin denies', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Not signed in', status: 401 })
    const res = await POST(makeReq({ confirm: 'REFUND' }), params)
    expect(res.status).toBe(401)
    expect(mockRefund).not.toHaveBeenCalled()
  })

  it('rejects 400 when confirm field is missing', async () => {
    const res = await POST(makeReq({}), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/REFUND/)
    expect(mockRefund).not.toHaveBeenCalled()
  })

  it('rejects 400 when confirm field is wrong text', async () => {
    const res = await POST(makeReq({ confirm: 'refund' }), params)
    expect(res.status).toBe(400)
    expect(mockRefund).not.toHaveBeenCalled()
  })

  it('returns 404 when recovery not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const res = await POST(makeReq({ confirm: 'REFUND' }), params)
    expect(res.status).toBe(404)
    expect(mockRefund).not.toHaveBeenCalled()
  })

  it('happy path: calls refundPerformanceFee + logs admin_action with method', async () => {
    const recentCharge = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    mockSelect.mockReturnValue(selectChain([{
      id: 'rec_1',
      customerId: 'cust_1',
      chargedAt: recentCharge,
      refundedAt: null,
    }]))
    mockRefund.mockResolvedValue({ method: 'credit_note' })

    const res = await POST(makeReq({ confirm: 'REFUND' }), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.method).toBe('credit_note')

    expect(mockRefund).toHaveBeenCalledWith('rec_1')
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        action: 'perf_fee_refunded',
        recoveryId: 'rec_1',
        method: 'credit_note',
        outsideWindow: false,
      }),
    }))
  })

  it('flags outsideWindow=true when chargedAt is older than 14 days', async () => {
    const oldCharge = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    mockSelect.mockReturnValue(selectChain([{
      id: 'rec_1',
      customerId: 'cust_1',
      chargedAt: oldCharge,
      refundedAt: null,
    }]))
    mockRefund.mockResolvedValue({ method: 'credit_note' })

    await POST(makeReq({ confirm: 'REFUND' }), params)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({
        outsideWindow: true,
      }),
    }))
  })

  it('error path: still logs admin_action with outcome=error', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'rec_1',
      customerId: 'cust_1',
      chargedAt: new Date(),
      refundedAt: null,
    }]))
    mockRefund.mockRejectedValue(new Error('Stripe API exploded'))

    const res = await POST(makeReq({ confirm: 'REFUND' }), params)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toMatch(/Stripe API exploded/)

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({
        action: 'perf_fee_refunded',
        outcome: 'error',
        errorMessage: 'Stripe API exploded',
      }),
    }))
  })
})
