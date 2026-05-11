/**
 * Spec 51 — /api/billing/opt-out route
 *
 * Verifies:
 *  - 400 with missing customer or token params
 *  - 403 with wrong token
 *  - 404 if customer doesn't exist
 *  - 200 sets billingEmailsOptedOutAt and logs event
 *  - 200 idempotent — re-clicking on already-opted-out customer is a no-op
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'crypto'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: { id: 'c.id', billingEmailsOptedOutAt: 'c.b_optout' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { GET } from '../../../app/api/billing/opt-out/route'

function setCustomer(row: { id: string; optedOutAt: Date | null } | null) {
  // Route selects with column alias: { id, optedOutAt: customers.billingEmailsOptedOutAt }
  // The mock receives the alias name back since Drizzle returns object-keyed.
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () =>
          Promise.resolve(
            row
              ? [{ id: row.id, optedOutAt: row.optedOutAt }]
              : [],
          ),
      }),
    }),
  }))
}

function validToken(customerId: string): string {
  return createHmac('sha256', 'test_secret').update(`billing-opt-out:${customerId}`).digest('hex')
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXTAUTH_SECRET = 'test_secret'
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
})

describe('GET /api/billing/opt-out', () => {
  it('400 with no params', async () => {
    const res = await GET(new Request('http://localhost/api/billing/opt-out') as never)
    expect(res.status).toBe(400)
  })

  it('400 with only customer param', async () => {
    const res = await GET(new Request('http://localhost/api/billing/opt-out?customer=c1') as never)
    expect(res.status).toBe(400)
  })

  it('403 with wrong token', async () => {
    const res = await GET(
      new Request('http://localhost/api/billing/opt-out?customer=c1&t=wrong') as never,
    )
    expect(res.status).toBe(403)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('404 if customer not found', async () => {
    setCustomer(null)
    const url = `http://localhost/api/billing/opt-out?customer=c1&t=${validToken('c1')}`
    const res = await GET(new Request(url) as never)
    expect(res.status).toBe(404)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('200 sets billingEmailsOptedOutAt on first opt-out', async () => {
    setCustomer({ id: 'c1', optedOutAt: null })
    const url = `http://localhost/api/billing/opt-out?customer=c1&t=${validToken('c1')}`
    const res = await GET(new Request(url) as never)
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalled()
    const setArg = (mockUpdate.mock.results[0].value.set as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(setArg.billingEmailsOptedOutAt).toBeInstanceOf(Date)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'billing_emails_opted_out',
        customerId: 'c1',
      }),
    )
  })

  it('200 idempotent — already opted out is a no-op (no update, no log)', async () => {
    setCustomer({ id: 'c1', optedOutAt: new Date(Date.now() - 60_000) })
    const url = `http://localhost/api/billing/opt-out?customer=c1&t=${validToken('c1')}`
    const res = await GET(new Request(url) as never)
    expect(res.status).toBe(200)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})
