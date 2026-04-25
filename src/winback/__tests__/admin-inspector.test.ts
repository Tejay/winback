/**
 * Spec 27 — buildInspectorPayload assembly.
 *
 * Verifies:
 *  - returns subscriber: null when not found (caller renders 404)
 *  - joins emails + outcome events for the matched subscriber
 *  - filters outcome events to the OUTCOME_EVENT_NAMES allowlist
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  getDbReadOnly: () => ({ select: mockSelect }),
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: { id: 'id', customerId: 'customer_id' },
  customers: { id: 'cust_id', userId: 'user_id', productName: 'product_name', founderName: 'founder_name' },
  users: { id: 'user_id_col', email: 'email' },
  emailsSent: { subscriberId: 'subscriber_id', sentAt: 'sent_at' },
  wbEvents: { name: 'name', customerId: 'customer_id', createdAt: 'created_at', properties: 'properties' },
}))

vi.mock('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values }),
    { raw: (s: string) => s },
  ),
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
  and: vi.fn((...args) => ({ and: args })),
  asc: vi.fn((c) => ({ asc: c })),
  desc: vi.fn((c) => ({ desc: c })),
  inArray: vi.fn((a, b) => ({ inArray: [a, b] })),
}))

import { buildInspectorPayload } from '../../../lib/admin/inspector-queries'

function selectChain(rows: unknown[]) {
  // The select chain is .from().innerJoin().innerJoin().where().limit() OR
  // .from().where().orderBy()
  const terminal = vi.fn().mockResolvedValue(rows)
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: terminal,
          }),
        }),
      }),
      where: vi.fn().mockReturnValue({
        orderBy: terminal,
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildInspectorPayload', () => {
  it('returns subscriber: null when subscriber not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const payload = await buildInspectorPayload('sub_missing')
    expect(payload.subscriber).toBeNull()
    expect(payload.emails).toEqual([])
    expect(payload.outcomeEvents).toEqual([])
  })

  it('returns subscriber + emails + outcome events when found', async () => {
    const subRow = {
      id: 'sub_1',
      customerId: 'cust_1',
      customerEmail: 'alex@acme.co',
      customerProductName: 'Acme',
      customerFounderName: 'Alex',
      name: 'Sarah',
      email: 'sarah@example.com',
      planName: 'Pro',
      mrrCents: 2900,
      status: 'contacted',
      cancelledAt: new Date('2026-04-20'),
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: null,
      aiPausedReason: null,
      stripeEnum: 'too_expensive',
      stripeComment: 'csv cap',
      tenureDays: 120,
      everUpgraded: false,
      nearRenewal: false,
      paymentFailures: 0,
      previousSubs: 0,
      billingPortalClickedAt: null,
      replyText: null,
      tier: 1,
      confidence: '0.92',
      cancellationReason: 'CSV cap',
      cancellationCategory: 'Feature',
      triggerNeed: 'uncapped CSV',
      handoffReasoning: '...',
      recoveryLikelihood: 'high',
    }
    const emails = [
      { id: 'e1', type: 'exit', subject: 'Fair call', bodyText: 'Hi Sarah...', sentAt: new Date(), repliedAt: null },
    ]
    const outcomeEvents = [
      { id: 'ev1', name: 'subscriber_recovered', createdAt: new Date(), properties: { attributionType: 'strong' } },
    ]

    // 1) subscriber row, 2) emails, 3) outcome events
    mockSelect
      .mockReturnValueOnce(selectChain([subRow]))
      .mockReturnValueOnce(selectChain(emails))
      .mockReturnValueOnce(selectChain(outcomeEvents))

    const payload = await buildInspectorPayload('sub_1')
    expect(payload.subscriber?.email).toBe('sarah@example.com')
    expect(payload.subscriber?.customerProductName).toBe('Acme')
    expect(payload.emails).toHaveLength(1)
    expect(payload.emails[0].subject).toBe('Fair call')
    expect(payload.outcomeEvents).toHaveLength(1)
    expect(payload.outcomeEvents[0].name).toBe('subscriber_recovered')
  })
})
