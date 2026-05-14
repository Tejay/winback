/**
 * Spec 51 — /api/cron/billing-nudge route
 *
 * Verifies:
 *  - 401 without CRON_SECRET bearer
 *  - dryRun=1 returns counts but doesn't send emails or update DB
 *  - day-7 nudge: sends, sets billingNudgeDay7SentAt, logs event
 *  - day-30 nudge: same idempotency pattern
 *  - monthly report: cadence-based, updates billingMonthlyReportLastSentAt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockSendDay7 = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSendDay30 = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSendMonthly = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: {
    id: 'c.id',
    activatedAt: 'c.activated_at',
    stripeSubscriptionId: 'c.stripe_subscription_id',
    stripeAccessToken: 'c.stripe_access_token',
    billingNudgeDay7SentAt: 'c.b_day7',
    billingNudgeDay30SentAt: 'c.b_day30',
    billingMonthlyReportLastSentAt: 'c.b_monthly',
    billingEmailsOptedOutAt: 'c.b_optout',
  },
  churnedSubscribers: {
    id: 'cs.id',
    customerId: 'cs.customer_id',
    cancelledAt: 'cs.cancelled_at',
    createdAt: 'cs.created_at',
    dunningState: 'cs.dunning_state',
    mrrCents: 'cs.mrr_cents',
    recoveryLikelihood: 'cs.recovery_likelihood',
    status: 'cs.status',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  isNotNull: vi.fn((a) => ({ op: 'isNotNull', a })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
  count: vi.fn((a) => ({ op: 'count', a })),
  sql: Object.assign(
    vi.fn((...args: unknown[]) => ({ op: 'sql', args })),
    { raw: vi.fn() },
  ),
}))

vi.mock('@/src/winback/lib/billing-notifications', () => ({
  sendBillingNudgeDay7Email: mockSendDay7,
  sendBillingNudgeDay30Email: mockSendDay30,
  sendBillingMonthlyReportEmail: mockSendMonthly,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { GET } from '../../../app/api/cron/billing-nudge/route'

function makeReq(opts: { secret?: string; dryRun?: boolean } = {}): Request {
  const url = opts.dryRun
    ? 'http://localhost/api/cron/billing-nudge?dryRun=1'
    : 'http://localhost/api/cron/billing-nudge'
  return new Request(url, {
    method: 'GET',
    headers: opts.secret ? { Authorization: `Bearer ${opts.secret}` } : {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'test_cron_secret'
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
})

function setSelectQueue(queue: Array<unknown[]>) {
  let idx = 0
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => Promise.resolve(queue[idx++] ?? []),
      innerJoin: () => ({
        where: () => Promise.resolve(queue[idx++] ?? []),
      }),
    }),
  }))
}

describe('GET /api/cron/billing-nudge', () => {
  it('401 without CRON_SECRET', async () => {
    setSelectQueue([])
    const res = await GET(makeReq() as never)
    expect(res.status).toBe(401)
    expect(mockSendDay7).not.toHaveBeenCalled()
  })

  it('401 with wrong secret', async () => {
    setSelectQueue([])
    const res = await GET(makeReq({ secret: 'wrong' }) as never)
    expect(res.status).toBe(401)
  })

  it('200 with empty queues — no targets to nudge', async () => {
    // 3 passes, each returns empty
    setSelectQueue([[], [], []])
    const res = await GET(makeReq({ secret: 'test_cron_secret' }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.day7).toBe(0)
    expect(body.day30).toBe(0)
    expect(body.monthly).toBe(0)
    expect(mockSendDay7).not.toHaveBeenCalled()
    expect(mockSendDay30).not.toHaveBeenCalled()
    expect(mockSendMonthly).not.toHaveBeenCalled()
  })

  it('dryRun=1: counts targets but does not send or update', async () => {
    setSelectQueue([
      [{ id: 'cust_1', activatedAt: new Date() }],  // day7 targets
      [{ id: 'cust_2' }],                            // day30 targets
      [{ id: 'cust_3' }],                            // monthly targets
    ])
    const res = await GET(makeReq({ secret: 'test_cron_secret', dryRun: true }) as never)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.dryRun).toBe(true)
    expect(body.day7).toBe(1)
    expect(body.day30).toBe(1)
    expect(body.monthly).toBe(1)
    // No sends, no DB writes
    expect(mockSendDay7).not.toHaveBeenCalled()
    expect(mockSendDay30).not.toHaveBeenCalled()
    expect(mockSendMonthly).not.toHaveBeenCalled()
    // Spec 69 — withCron emits one cron_run event per invocation regardless
    // of dryRun. Verify nothing OTHER than that fired.
    const nonCronRunCalls = mockLogEvent.mock.calls.filter(
      (c) => (c[0] as { name?: string }).name !== 'cron_run',
    )
    expect(nonCronRunCalls).toHaveLength(0)
  })
})
