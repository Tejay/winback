/**
 * Spec 72 — classifier tick tests.
 *
 * Verifies the consumer-side behaviour:
 *  - Silent-churn rows skip the LLM call (cost-saving fast path)
 *  - Successful classify sets classified_at + updates fields
 *  - Failed classify increments classify_attempts + logs classify_failed
 *  - After 3rd failure, classify_dead_lettered event emits
 *  - Recent cancellations trigger scheduleExitEmail; old ones don't
 *
 * The hot-path helpers hasSignalForLLM + classifySilentChurn are
 * unit-tested separately in reengagement.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect      = vi.hoisted(() => vi.fn())
const mockUpdate      = vi.hoisted(() => vi.fn())
const mockClassify    = vi.hoisted(() => vi.fn())
const mockScheduleExit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent    = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockBuildThread = vi.hoisted(() => vi.fn().mockResolvedValue([]))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: {
    id: 'id',
    customerId: 'customer_id',
    classifiedAt: 'classified_at',
    classifyAttempts: 'classify_attempts',
    createdAt: 'created_at',
    cancelledAt: 'cancelled_at',
  },
  customers: { id: 'cust_id' },
}))

vi.mock('drizzle-orm', () => ({
  and:   vi.fn((...args: unknown[]) => ({ and: args })),
  eq:    vi.fn((a, b) => ({ eq: [a, b] })),
  isNull: vi.fn((a) => ({ isNull: a })),
  asc:   vi.fn((c) => ({ asc: c })),
  lt:    vi.fn((a, b) => ({ lt: [a, b] })),
  count: vi.fn(() => ({ count: true })),
  sql:   Object.assign(
    (..._args: unknown[]) => ({ sql: 'mock' }),
    { raw: (s: string) => s },
  ),
}))

vi.mock('../lib/classifier', () => ({ classifySubscriber: mockClassify }))
vi.mock('../lib/email', () => ({ scheduleExitEmail: mockScheduleExit }))
vi.mock('../lib/events', () => ({ logEvent: mockLogEvent }))
vi.mock('../lib/conversation', () => ({ buildConversationThread: mockBuildThread }))

import { runClassifierTick } from '../lib/classifier-tick'

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}
function updateChain(returningRows: unknown[] = []) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returningRows),
        // Some callers don't chain .returning — make .where() awaitable too.
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      }),
    }),
  }
}

const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)  // 2 days ago

function rowSilentChurn(over: Record<string, unknown> = {}) {
  return {
    id: 'sub_silent',
    customerId: 'cust_1',
    stripeCustomerId: 'cus_x',
    stripeSubscriptionId: null,
    stripePriceId: null,
    email: 'silent@example.com',
    name: 'Silent',
    planName: 'Pro',
    mrrCents: 2900,
    tenureDays: 90,
    everUpgraded: false,
    nearRenewal: false,
    paymentFailures: 0,
    previousSubs: 0,
    stripeEnum: null,
    stripeComment: null,
    cancelledAt: RECENT,
    status: 'pending',
    billingPortalClickedAt: null,
    ...over,
  }
}

function rowWithSignal(over: Record<string, unknown> = {}) {
  return rowSilentChurn({
    id: 'sub_signal',
    stripeEnum: 'too_expensive',
    stripeComment: 'too pricey for what we use',
    ...over,
  })
}

const successClassification = {
  tier: 2,
  tierReason: 'stripe enum present',
  cancellationReason: 'price',
  cancellationCategory: 'Price',
  confidence: 0.85,
  suppress: false,
  firstMessage: { subject: 's', body: 'b', sendDelaySecs: 0 },
  triggerKeyword: 'price',
  triggerNeed: null,
  winBackSubject: '',
  winBackBody: '',
  handoff: false,
  handoffReasoning: '',
  recoveryLikelihood: 'medium' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runClassifierTick', () => {
  it('returns zero stats when no unclassified rows exist', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const stats = await runClassifierTick()
    expect(stats.picked).toBe(0)
    expect(mockClassify).not.toHaveBeenCalled()
  })

  it('silent-churn row: skips LLM call, marks classified, no exit email (firstMessage is null)', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([rowSilentChurn()]))    // pick rows
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))  // customer
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    expect(stats.picked).toBe(1)
    expect(stats.classified).toBe(1)
    expect(mockClassify).not.toHaveBeenCalled()  // silent-churn skips LLM
    // Silent-churn classification has firstMessage = null — nothing to send.
    expect(mockScheduleExit).not.toHaveBeenCalled()
    expect(stats.exitEmailsSent).toBe(0)
  })

  it('signal-bearing row: calls LLM, marks classified', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([rowWithSignal()]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
    mockClassify.mockResolvedValue(successClassification)
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    expect(stats.classified).toBe(1)
    expect(mockClassify).toHaveBeenCalledOnce()
    expect(stats.exitEmailsSent).toBe(1)
  })

  it('classifier throws: increments classify_attempts, logs classify_failed', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([rowWithSignal()]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
    mockClassify.mockRejectedValue(new Error('Anthropic 429'))
    // First update is the failure increment; returning is the new attempts count.
    mockUpdate.mockReturnValue(updateChain([{ attempts: 1 }]))

    const stats = await runClassifierTick()
    expect(stats.failed).toBe(1)
    expect(stats.classified).toBe(0)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'classify_failed',
      properties: expect.objectContaining({
        subscriberId: 'sub_signal',
        attempts: 1,
        errorMessage: 'Anthropic 429',
      }),
    }))
  })

  it('after 3rd failure, emits classify_dead_lettered event', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([rowWithSignal()]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
    mockClassify.mockRejectedValue(new Error('still failing'))
    // The returning chain reports attempts = 3 (this was the 3rd try)
    mockUpdate.mockReturnValue(updateChain([{ attempts: 3 }]))

    const stats = await runClassifierTick()
    expect(stats.deadLettered).toBe(1)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'classify_dead_lettered',
      properties: expect.objectContaining({
        subscriberId: 'sub_signal',
        attempts: 3,
      }),
    }))
  })

  it('old cancellation: classifies but does NOT send exit email', async () => {
    const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    mockSelect
      .mockReturnValueOnce(selectChain([rowWithSignal({ cancelledAt: TEN_DAYS_AGO })]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
    mockClassify.mockResolvedValue(successClassification)
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    expect(stats.classified).toBe(1)
    expect(stats.exitEmailsSent).toBe(0)
    expect(mockScheduleExit).not.toHaveBeenCalled()
  })
})
