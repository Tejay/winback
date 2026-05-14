/**
 * Spec 70 — subscriber-lifecycle admin endpoint tests.
 *
 * Covers the three new endpoints (#2 flag-email, #3 force-status,
 * #4 send-reengagement-now). The V2 cron emit-skipped path is
 * already exercised by the existing reengagement tests; the gate
 * + audit logic for each endpoint is what's tested here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAdmin = vi.hoisted(() => vi.fn())
const mockSelect       = vi.hoisted(() => vi.fn())
const mockUpdate       = vi.hoisted(() => vi.fn())
const mockProcessSub   = vi.hoisted(() => vi.fn())
const mockLogEvent     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/auth', () => ({
  requireAdmin: mockRequireAdmin,
}))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: {
    id: 'id',
    status: 'status',
    customerId: 'customer_id',
    updatedAt: 'updated_at',
    reengagementExpiredAt: 'reengagement_expired_at',
  },
  emailsSent:  { id: 'id', subscriberId: 'subscriber_id', type: 'type', subject: 'subject' },
  users:       { id: 'id', email: 'email' },
}))

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn((a, b) => ({ eq: [a, b] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}))

vi.mock('@/src/winback/lib/reengagement-cron-v2', () => ({
  processSubscriberForReengagement: mockProcessSub,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST as flagPOST }     from '../../../app/api/admin/subscribers/[id]/flag-email/route'
import { POST as statusPOST }   from '../../../app/api/admin/subscribers/[id]/force-status/route'
import { POST as sendNowPOST }  from '../../../app/api/admin/subscribers/[id]/send-reengagement-now/route'

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
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

function makeReq(body: unknown, path = 'http://localhost/api/admin/subscribers/sub_1/x'): Request {
  return new Request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

const params = { params: Promise.resolve({ id: 'sub_1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
})

// ────────────────────────────────────────────────────────────────────
// #2 — flag-email
// ────────────────────────────────────────────────────────────────────
describe('POST /api/admin/subscribers/[id]/flag-email', () => {
  it('rejects 401 when requireAdmin denies', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Not signed in', status: 401 })
    const res = await flagPOST(makeReq({ emailId: 'em_1' }), params)
    expect(res.status).toBe(401)
  })

  it('rejects 400 when emailId missing', async () => {
    const res = await flagPOST(makeReq({}), params)
    expect(res.status).toBe(400)
  })

  it('rejects 404 when email doesn\'t belong to subscriber', async () => {
    mockSelect.mockReturnValueOnce(selectChain([]))
    const res = await flagPOST(makeReq({ emailId: 'em_1' }), params)
    expect(res.status).toBe(404)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('happy path: logs email_flagged event with note', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([{
        id: 'em_1', type: 'reengagement', subject: 'We shipped X',
        subscriberId: 'sub_1', customerId: 'cust_1',
      }]))
      .mockReturnValueOnce(selectChain([{ email: 'admin@example.com' }]))

    const res = await flagPOST(makeReq({ emailId: 'em_1', note: 'topic drift' }), params)
    expect(res.status).toBe(200)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'email_flagged',
      userId: 'admin_1',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        subscriberId: 'sub_1',
        emailId: 'em_1',
        type: 'reengagement',
        note: 'topic drift',
      }),
    }))
  })
})

// ────────────────────────────────────────────────────────────────────
// #3 — force-status
// ────────────────────────────────────────────────────────────────────
describe('POST /api/admin/subscribers/[id]/force-status', () => {
  it('rejects 400 when status is invalid', async () => {
    const res = await statusPOST(makeReq({ status: 'bogus', note: 'long enough' }), params)
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects 400 when note is too short', async () => {
    const res = await statusPOST(makeReq({ status: 'recovered', note: 'hi' }), params)
    expect(res.status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects 404 when subscriber not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const res = await statusPOST(makeReq({ status: 'recovered', note: 'merchant confirmed' }), params)
    expect(res.status).toBe(404)
  })

  it('rejects 400 when status is already the requested value (no-op)', async () => {
    mockSelect.mockReturnValue(selectChain([{ status: 'recovered', customerId: 'cust_1' }]))
    const res = await statusPOST(makeReq({ status: 'recovered', note: 'merchant confirmed' }), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/already/i)
  })

  it('happy path: updates row + logs subscriber_force_status admin_action', async () => {
    mockSelect.mockReturnValue(selectChain([{
      status: 'lost', customerId: 'cust_1', reengagementExpiredAt: null,
    }]))
    mockUpdate.mockReturnValue(updateChain())

    const res = await statusPOST(
      makeReq({ status: 'pending', note: 'subscriber emailed founder, wants to return' }),
      params,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.oldStatus).toBe('lost')
    expect(body.newStatus).toBe('pending')

    expect(mockUpdate).toHaveBeenCalledOnce()
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        action: 'subscriber_force_status',
        subscriberId: 'sub_1',
        oldStatus: 'lost',
        newStatus: 'pending',
        note: 'subscriber emailed founder, wants to return',
      }),
    }))
  })

  it('reviving (flip away from lost AND expired_at is set): clears reengagement_expired_at + flags revived:true in audit', async () => {
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
    mockSelect.mockReturnValue(selectChain([{
      status: 'lost',
      customerId: 'cust_1',
      reengagementExpiredAt: new Date(),  // 9-month wall is armed
    }]))
    mockUpdate.mockReturnValue({ set: setMock })

    const res = await statusPOST(
      makeReq({ status: 'pending', note: 'subscriber emailed back, wants to come back' }),
      params,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.revived).toBe(true)

    // The update.set() payload must include reengagementExpiredAt: null
    // so the next send-now / cron pass treats this row as eligible.
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      reengagementExpiredAt: null,
    }))
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({ revived: true }),
    }))
  })

  it('flipping TO lost does not clear reengagement_expired_at', async () => {
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
    mockSelect.mockReturnValue(selectChain([{
      status: 'contacted',
      customerId: 'cust_1',
      reengagementExpiredAt: null,
    }]))
    mockUpdate.mockReturnValue({ set: setMock })

    await statusPOST(
      makeReq({ status: 'lost', note: 'subscriber confirmed they will not return' }),
      params,
    )
    // The set payload should NOT contain reengagementExpiredAt at all
    // (we only clear it on revive).
    const setArg = setMock.mock.calls[0][0]
    expect(setArg.status).toBe('lost')
    expect('reengagementExpiredAt' in setArg).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────
// #4 — send-reengagement-now
// ────────────────────────────────────────────────────────────────────
describe('POST /api/admin/subscribers/[id]/send-reengagement-now', () => {
  it('rejects 400 when confirm is missing', async () => {
    const res = await sendNowPOST(makeReq({}), params)
    expect(res.status).toBe(400)
    expect(mockProcessSub).not.toHaveBeenCalled()
  })

  it('rejects 404 when subscriber not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const res = await sendNowPOST(makeReq({ confirm: 'SEND' }), params)
    expect(res.status).toBe(404)
  })

  it('rejects 409 when subscriber is past the 9-month wall', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'sub_1', customerId: 'cust_1', reengagementExpiredAt: new Date(),
    }]))
    const res = await sendNowPOST(makeReq({ confirm: 'SEND' }), params)
    expect(res.status).toBe(409)
    expect(mockProcessSub).not.toHaveBeenCalled()
  })

  it('happy path: calls processSubscriberForReengagement with bypassCooldown:true + logs', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'sub_1', customerId: 'cust_1', reengagementExpiredAt: null,
    }]))
    mockProcessSub.mockResolvedValue({ kind: 'emailed', improvementId: 'imp_1' })

    const res = await sendNowPOST(makeReq({ confirm: 'SEND' }), params)
    expect(res.status).toBe(200)

    expect(mockProcessSub).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sub_1' }),
      { bypassCooldown: true },
    )
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      properties: expect.objectContaining({
        action: 'reengagement_force_sent',
        subscriberId: 'sub_1',
        outcome: 'emailed',
        improvementId: 'imp_1',
      }),
    }))
  })

  it('captures skip outcome with reason in audit log', async () => {
    mockSelect.mockReturnValue(selectChain([{
      id: 'sub_1', customerId: 'cust_1', reengagementExpiredAt: null,
    }]))
    mockProcessSub.mockResolvedValue({ kind: 'skipped', reason: 'no_match' })

    await sendNowPOST(makeReq({ confirm: 'SEND' }), params)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({
        outcome: 'skipped',
        reason: 'no_match',
      }),
    }))
  })
})
