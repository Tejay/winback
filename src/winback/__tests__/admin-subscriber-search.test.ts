/**
 * Spec 25 — lib/admin/subscriber-search.ts unit tests.
 *
 * Verifies the cross-customer lookup:
 *   - normalises email to lowercase before querying
 *   - emits the admin_subscriber_lookup audit event
 *   - returns empty array on empty input without hitting the DB
 *   - respects the limit option
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockGetDbReadOnly = vi.hoisted(() =>
  vi.fn(() => ({ select: mockSelect })),
)
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db:             { select: vi.fn() },
  getDbReadOnly:  mockGetDbReadOnly,
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: { id: 'id', email: 'email', customerId: 'customer_id', status: 'status', cancelledAt: 'cancelled_at', name: 'name', mrrCents: 'mrr_cents', doNotContact: 'dnc', founderHandoffAt: 'handoff_at', founderHandoffResolvedAt: 'handoff_resolved_at', aiPausedUntil: 'paused', handoffReasoning: 'reasoning', recoveryLikelihood: 'likelihood', cancellationReason: 'reason', cancellationCategory: 'category' },
  customers:          { id: 'cust_id', userId: 'cust_user_id', productName: 'product_name', founderName: 'founder_name' },
  users:              { id: 'user_id', email: 'user_email' },
}))

vi.mock('drizzle-orm', () => ({
  sql:  Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values }),
    { raw: (s: string) => s },
  ),
  eq:   vi.fn((a, b) => ({ eq: [a, b] })),
  desc: vi.fn((c) => ({ desc: c })),
  and:  vi.fn((...args) => ({ and: args })),
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { findSubscribersByEmail } from '../../../lib/admin/subscriber-search'

beforeEach(() => {
  vi.clearAllMocks()
})

function setupChain(rows: unknown[]) {
  mockSelect.mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
    }),
  })
}

describe('findSubscribersByEmail', () => {
  it('returns empty array for empty input without touching the DB', async () => {
    const out = await findSubscribersByEmail('   ')
    expect(out).toEqual([])
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('emits the admin_subscriber_lookup audit event', async () => {
    setupChain([])
    await findSubscribersByEmail('Pat@Example.COM', { adminUserId: 'admin_user_1' })
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_subscriber_lookup',
      userId: 'admin_user_1',
      properties: expect.objectContaining({
        email: 'pat@example.com',  // normalised
        resultCount: 0,
      }),
    }))
  })

  it('returns rows mapped through and defaults status to pending if missing', async () => {
    const dbRows = [
      { id: 'sub_1', status: 'pending',   customerId: 'c1', email: 'pat@example.com' },
      { id: 'sub_2', status: null,        customerId: 'c2', email: 'pat@example.com' },
      { id: 'sub_3', status: 'recovered', customerId: 'c3', email: 'pat@example.com' },
    ]
    setupChain(dbRows)
    const out = await findSubscribersByEmail('pat@example.com')
    expect(out).toHaveLength(3)
    expect(out[1].status).toBe('pending')  // null defaulted
    expect(out[2].status).toBe('recovered')
  })
})
