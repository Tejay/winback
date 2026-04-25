/**
 * Spec 26 — POST /api/admin/actions/billing-retry.
 *
 * Verifies:
 *  - rejects non-failed runs with 409 (won't overwrite paid runs)
 *  - 404 when run not found
 *  - calls processBillingRun with isRetry: true on the right (customerId, period)
 *  - logs admin_action with the outcome from processBillingRun
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockProcessBillingRun = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockRequireAdmin = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/auth', () => ({
  requireAdmin: mockRequireAdmin,
}))

vi.mock('@/lib/schema', () => ({
  billingRuns: { id: 'id', customerId: 'customer_id', periodYyyymm: 'period_yyyymm', status: 'status' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

vi.mock('@/src/winback/lib/billing', () => ({
  processBillingRun: mockProcessBillingRun,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/admin/actions/billing-retry/route'

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
  return new Request('http://localhost/api/admin/actions/billing-retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
})

describe('POST /api/admin/actions/billing-retry', () => {
  it('returns 404 when run not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const res = await POST(makeReq({ runId: 'run_x' }))
    expect(res.status).toBe(404)
    expect(mockProcessBillingRun).not.toHaveBeenCalled()
  })

  it('returns 409 when run is in paid state — refuses to overwrite', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'run_paid', customerId: 'cust_1', periodYyyymm: '2026-03', status: 'paid',
    }]))
    const res = await POST(makeReq({ runId: 'run_paid' }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error).toContain('paid')
    expect(mockProcessBillingRun).not.toHaveBeenCalled()
  })

  it('returns 409 when run is in pending state', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'run_pending', customerId: 'cust_1', periodYyyymm: '2026-03', status: 'pending',
    }]))
    const res = await POST(makeReq({ runId: 'run_pending' }))
    expect(res.status).toBe(409)
    expect(mockProcessBillingRun).not.toHaveBeenCalled()
  })

  it('calls processBillingRun with isRetry: true and logs admin_action', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'run_failed', customerId: 'cust_1', periodYyyymm: '2026-03', status: 'failed',
    }]))
    mockProcessBillingRun.mockResolvedValue({
      outcome: 'created',
      billingRunId: 'run_failed',
      stripeInvoiceId: 'in_xxx',
      amountCents: 4500,
    })

    const res = await POST(makeReq({ runId: 'run_failed' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.outcome).toBe('created')

    expect(mockProcessBillingRun).toHaveBeenCalledWith('cust_1', '2026-03', { isRetry: true })

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        action: 'billing_retry',
        runId: 'run_failed',
        period: '2026-03',
        outcome: 'created',
        stripeInvoiceId: 'in_xxx',
      }),
    }))
  })

  it('returns ok:false when processBillingRun reports an error outcome', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'run_failed', customerId: 'cust_1', periodYyyymm: '2026-03', status: 'failed',
    }]))
    mockProcessBillingRun.mockResolvedValue({
      outcome: 'error',
      billingRunId: 'run_failed',
      errorMessage: 'Stripe down',
    })

    const res = await POST(makeReq({ runId: 'run_failed' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.errorMessage).toBe('Stripe down')
  })

  it('rejects missing runId with 400 before any DB lookup', async () => {
    const res = await POST(makeReq({}))
    expect(res.status).toBe(400)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('respects auth gate', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Admin only', status: 403 })
    const res = await POST(makeReq({ runId: 'run_x' }))
    expect(res.status).toBe(403)
    expect(mockSelect).not.toHaveBeenCalled()
  })
})
