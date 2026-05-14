/**
 * Spec 72 — POST /api/admin/subscribers/[id]/reset-classify tests.
 *
 * Verifies the gate behaviour: admin auth, not-found 404, already-zero
 * 400, happy path resets attempts + logs admin_action with the previous
 * value.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAdmin = vi.hoisted(() => vi.fn())
const mockSelect       = vi.hoisted(() => vi.fn())
const mockUpdate       = vi.hoisted(() => vi.fn())
const mockLogEvent     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/auth', () => ({ requireAdmin: mockRequireAdmin }))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: {
    id: 'id',
    customerId: 'customer_id',
    classifyAttempts: 'classify_attempts',
    updatedAt: 'updated_at',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/admin/subscribers/[id]/reset-classify/route'

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}
function updateChain() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makeReq(): Request {
  return new Request('http://localhost/api/admin/subscribers/sub_1/reset-classify', { method: 'POST' })
}

const params = { params: Promise.resolve({ id: 'sub_1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
})

describe('POST /api/admin/subscribers/[id]/reset-classify', () => {
  it('rejects 401 when requireAdmin denies', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Not signed in', status: 401 })
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(401)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects 404 when subscriber not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(404)
  })

  it('rejects 400 when classify_attempts is already 0', async () => {
    mockSelect.mockReturnValue(selectChain([{ id: 'sub_1', customerId: 'cust_1', classifyAttempts: 0 }]))
    const res = await POST(makeReq(), params)
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('happy path: resets attempts + logs admin_action with previousAttempts', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'sub_1', customerId: 'cust_1', classifyAttempts: 3,
    }]))
    mockUpdate.mockReturnValue(updateChain())

    const res = await POST(makeReq(), params)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.previousAttempts).toBe(3)

    expect(mockUpdate).toHaveBeenCalledOnce()
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        action: 'reset_classify_attempts',
        subscriberId: 'sub_1',
        previousAttempts: 3,
      }),
    }))
  })
})
