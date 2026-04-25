/**
 * Spec 26 — POST /api/admin/actions/bulk-unsubscribe.
 *
 * Verifies:
 *  - happy path: marks N rows as DNC and emits ONE admin_action event with the batch
 *  - rejects empty arrays
 *  - rejects oversized batches (max 100)
 *  - auth gate fires before any DB work
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpdate = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockRequireAdmin = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { update: mockUpdate },
}))

vi.mock('@/lib/auth', () => ({
  requireAdmin: mockRequireAdmin,
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: { id: 'sub_id' },
}))

vi.mock('drizzle-orm', () => ({
  inArray: vi.fn((a, b) => ({ inArray: [a, b] })),
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/admin/actions/bulk-unsubscribe/route'

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([
          { id: 'sub_1' }, { id: 'sub_2' }, { id: 'sub_3' },
        ]),
      }),
    }),
  })
})

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/actions/bulk-unsubscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/actions/bulk-unsubscribe', () => {
  it('marks all rows as DNC and emits ONE admin_action with the batch', async () => {
    const res = await POST(makeReq({ subscriberIds: ['sub_1', 'sub_2', 'sub_3'] }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ ok: true, count: 3 })

    // Single update call with the batch, single audit event.
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      properties: expect.objectContaining({
        action: 'bulk_unsubscribe',
        requestedCount: 3,
        updatedCount: 3,
        subscriberIds: ['sub_1', 'sub_2', 'sub_3'],
      }),
    }))
  })

  it('rejects empty array with 400', async () => {
    const res = await POST(makeReq({ subscriberIds: [] }))
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('rejects missing subscriberIds with 400', async () => {
    const res = await POST(makeReq({}))
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects batch larger than 100 with 400', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `sub_${i}`)
    const res = await POST(makeReq({ subscriberIds: ids }))
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns 401/403 from requireAdmin and skips DB', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Not signed in', status: 401 })
    const res = await POST(makeReq({ subscriberIds: ['x'] }))
    expect(res.status).toBe(401)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})
