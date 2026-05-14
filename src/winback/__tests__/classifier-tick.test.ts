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

  it('silent-churn row: skips LLM call, marks classified, sends generic "asking why" email', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([rowSilentChurn()]))    // pick rows
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex', productName: 'Acme' }]))
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    expect(stats.picked).toBe(1)
    expect(stats.classified).toBe(1)
    expect(mockClassify).not.toHaveBeenCalled()  // silent-churn skips LLM
    // Silent churn now sends a generic "asking why" exit email so we
    // can elicit signal from the otherwise-silent cohort.
    expect(mockScheduleExit).toHaveBeenCalledOnce()
    expect(stats.exitEmailsSent).toBe(1)
    const scheduleCall = mockScheduleExit.mock.calls[0][0] as {
      classification: { firstMessage: { subject: string; body: string } | null }
    }
    expect(scheduleCall.classification.firstMessage?.subject).toContain('A quick question')
    expect(scheduleCall.classification.firstMessage?.body).toContain('Acme')   // productName
    expect(scheduleCall.classification.firstMessage?.body).toContain('Alex')   // founderName
    expect(scheduleCall.classification.firstMessage?.body).toContain('recently')
  })

  it('silent-churn row: sends ask email within the 90-day window (not just 7d like signal-bearing)', async () => {
    const FORTY_DAYS_AGO = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    mockSelect
      .mockReturnValueOnce(selectChain([rowSilentChurn({ cancelledAt: FORTY_DAYS_AGO })]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex', productName: 'Acme' }]))
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    // 40 days > the 7-day signal-bearing window, but well within
    // the 90-day silent-churn window. Email should still send.
    expect(stats.exitEmailsSent).toBe(1)
  })

  it('silent-churn row: outside the 90-day window — no email', async () => {
    const HUNDRED_DAYS_AGO = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    mockSelect
      .mockReturnValueOnce(selectChain([rowSilentChurn({ cancelledAt: HUNDRED_DAYS_AGO })]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex', productName: 'Acme' }]))
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    expect(stats.exitEmailsSent).toBe(0)
    expect(stats.classified).toBe(1)  // still gets classified
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

  it('signal-bearing within 90-day window: classifies AND sends exit email', async () => {
    // Spec 72 — recency window is 90 days for both paths. 10 days is well
    // within the window so the email DOES fire.
    const TEN_DAYS_AGO = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    mockSelect
      .mockReturnValueOnce(selectChain([rowWithSignal({ cancelledAt: TEN_DAYS_AGO })]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
    mockClassify.mockResolvedValue(successClassification)
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    expect(stats.classified).toBe(1)
    expect(stats.exitEmailsSent).toBe(1)
  })

  it('signal-bearing OUTSIDE 90-day window: classifies but does NOT send', async () => {
    // 100 days is past the 90d cap. The classifier's own age-awareness
    // would likely suppress anyway, but the hard code gate kicks in too.
    const HUNDRED_DAYS_AGO = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
    mockSelect
      .mockReturnValueOnce(selectChain([rowWithSignal({ cancelledAt: HUNDRED_DAYS_AGO })]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
    mockClassify.mockResolvedValue(successClassification)
    mockUpdate.mockReturnValue(updateChain())

    const stats = await runClassifierTick()
    expect(stats.classified).toBe(1)
    expect(stats.exitEmailsSent).toBe(0)
    expect(mockScheduleExit).not.toHaveBeenCalled()
  })

  // ─── Spec 72 funnel — triggerNeedConfidence persistence ──────────────

  it('signal-bearing: derives + persists triggerNeedConfidence', async () => {
    // High-confidence classification (≥ 0.7, non-Other, triggerNeed
    // populated) should derive 'high' → V2 cron eligible.
    const goodSignal = {
      ...successClassification,
      confidence: 0.92,
      cancellationCategory: 'Feature',
      triggerNeed: 'Wants Zapier integration with CRM',
    }
    const setCalls = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
    mockSelect
      .mockReturnValueOnce(selectChain([rowWithSignal()]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
    mockClassify.mockResolvedValue(goodSignal)
    mockUpdate.mockReturnValue({ set: setCalls })

    await runClassifierTick()

    // Find the persist call that updated the row (the one with the
    // classification fields). It should also carry triggerNeedConfidence.
    const persistArgs = setCalls.mock.calls.find(
      (c: unknown[]) => (c[0] as { tier?: unknown }).tier !== undefined,
    )?.[0] as { triggerNeedConfidence?: string } | undefined
    expect(persistArgs?.triggerNeedConfidence).toBe('high')
  })

  it('silent-churn: does NOT persist triggerNeedConfidence (leaves NULL)', async () => {
    const setCalls = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
    mockSelect
      .mockReturnValueOnce(selectChain([rowSilentChurn()]))
      .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex', productName: 'Acme' }]))
    mockUpdate.mockReturnValue({ set: setCalls })

    await runClassifierTick()

    const persistArgs = setCalls.mock.calls.find(
      (c: unknown[]) => (c[0] as { tier?: unknown }).tier !== undefined,
    )?.[0] as { triggerNeedConfidence?: string } | undefined
    // Silent churn: classifier-tick MUST leave triggerNeedConfidence
    // unset so the inbound webhook can flip it to 'high' later if a
    // reply elicits real signal.
    expect(persistArgs?.triggerNeedConfidence).toBeUndefined()
  })
})
