/**
 * Spec 50 — POST /api/subscribers/[id]/external-contact
 *
 * Verifies:
 *   - lost subscriber → 200, stub emails_sent row inserted, status flipped to 'contacted'
 *   - contacted subscriber → 200, stub row inserted, status preserved (no flip)
 *   - recovered subscriber → 400, no DB writes
 *   - DNC subscriber → 403, no DB writes
 *   - unauthorized → 401, no DB lookups
 *   - subscriber owned by a different customer → 404, no inserts/updates
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuth          = vi.hoisted(() => vi.fn())
const mockIsDNC         = vi.hoisted(() => vi.fn())
const mockLogEvent      = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockDbSelect      = vi.hoisted(() => vi.fn())
const mockDbInsert      = vi.hoisted(() => vi.fn())
const mockDbUpdate      = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({
  auth: mockAuth,
}))

vi.mock('@/lib/db', () => ({
  db: {
    select: mockDbSelect,
    insert: mockDbInsert,
    update: mockDbUpdate,
  },
}))

vi.mock('@/lib/schema', () => ({
  customers: { id: 'customers_id', userId: 'customers_user_id' },
  churnedSubscribers: { id: 'cs_id', customerId: 'cs_customer_id', status: 'cs_status' },
  emailsSent: { subscriberId: 'es_subscriber_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn((a, b) => ({ eq:  [a, b] })),
  and: vi.fn((...xs) => ({ and: xs })),
}))

vi.mock('@/src/winback/lib/email', () => ({
  isDoNotContact: mockIsDNC,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/subscribers/[id]/external-contact/route'

type Row = { id: string; status?: string; userId?: string; customerId?: string }
function selectChain(rows: Row[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}
function insertChain() {
  const values = vi.fn().mockResolvedValue(undefined)
  mockDbInsert.mockReturnValue({ values })
  return values
}
function updateChain() {
  const where = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn().mockReturnValue({ where })
  mockDbUpdate.mockReturnValue({ set })
  return { set, where }
}

function makeReq(): Request {
  return new Request('http://localhost/api/subscribers/sub_1/external-contact', {
    method: 'POST',
  })
}
const params = Promise.resolve({ id: 'sub_1' })

beforeEach(() => {
  vi.clearAllMocks()
  mockIsDNC.mockResolvedValue(false)
})

describe('POST /api/subscribers/[id]/external-contact', () => {
  it('unauthorized → 401, no DB lookups', async () => {
    mockAuth.mockResolvedValue(null)
    const res = await POST(makeReq(), { params })
    expect(res.status).toBe(401)
    expect(mockDbSelect).not.toHaveBeenCalled()
  })

  it('lost subscriber → 200, stub row inserted, status flipped to contacted', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1', name: 'Tejay' } })
    mockDbSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', userId: 'user_1' }]))                   // customer lookup
      .mockReturnValueOnce(selectChain([{ id: 'sub_1', customerId: 'cust_1', status: 'lost' }])) // subscriber lookup
    const insertValues = insertChain()
    const update = updateChain()

    const res = await POST(makeReq(), { params })

    expect(res.status).toBe(200)
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      subscriberId: 'sub_1',
      type: 'manual_external',
    }))
    expect(update.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'contacted' }))
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'external_contact_marked',
      properties: expect.objectContaining({ subscriberId: 'sub_1', previousStatus: 'lost' }),
    }))
  })

  it('contacted subscriber → 200, stub row inserted, status preserved', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockDbSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', userId: 'user_1' }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub_1', customerId: 'cust_1', status: 'contacted' }]))
    const insertValues = insertChain()

    const res = await POST(makeReq(), { params })

    expect(res.status).toBe(200)
    expect(insertValues).toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()  // no status flip on contacted
  })

  it('recovered subscriber → 400, no DB writes', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockDbSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', userId: 'user_1' }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub_1', customerId: 'cust_1', status: 'recovered' }]))

    const res = await POST(makeReq(), { params })

    expect(res.status).toBe(400)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('DNC subscriber → 403, no DB writes', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockDbSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', userId: 'user_1' }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub_1', customerId: 'cust_1', status: 'lost' }]))
    mockIsDNC.mockResolvedValue(true)

    const res = await POST(makeReq(), { params })

    expect(res.status).toBe(403)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('subscriber not found (different customer scope) → 404, no writes', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockDbSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', userId: 'user_1' }]))
      .mockReturnValueOnce(selectChain([]))  // no row — subscriber belongs to a different workspace

    const res = await POST(makeReq(), { params })

    expect(res.status).toBe(404)
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })
})
