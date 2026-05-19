/**
 * Spec 54 — Drain on subscribe.
 *
 * Coverage focuses on the per-row state durability guarantees:
 *   1. Successful processing marks pause_drain_processed_at
 *   2. Per-row classifier failure leaves that row unmarked (so next tick
 *      retries) while preceding successful rows stay marked
 *   3. Send failures inside the email functions don't mark — handled the
 *      same way via the try/catch in safeProcess
 *   4. Classifier suppress / handoff still mark the row processed (terminal
 *      outcomes, not retries)
 *   5. getPausedQueueCounts returns the per-category breakdown
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── hoisted mocks ─────────────────────────────────────────────────────────

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockClassify = vi.hoisted(() => vi.fn())
const mockScheduleExit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSendDunning = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSendDunningFollowup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: 'wb_customers',
  churnedSubscribers: 'wb_churned_subscribers',
  emailsSent: 'wb_emails_sent',
  subscriberReplies: 'wb_subscriber_replies',
}))

vi.mock('drizzle-orm', () => ({
  eq:        vi.fn((a, b) => ({ op: 'eq', a, b })),
  and:       vi.fn((...args) => ({ op: 'and', args })),
  or:        vi.fn((...args) => ({ op: 'or', args })),
  isNull:    vi.fn((a) => ({ op: 'isNull', a })),
  isNotNull: vi.fn((a) => ({ op: 'isNotNull', a })),
  ne:        vi.fn((a, b) => ({ op: 'ne', a, b })),
  lte:       vi.fn((a, b) => ({ op: 'lte', a, b })),
  sql:       Object.assign(
    vi.fn((..._args: unknown[]) => ({ op: 'sql' })),
    { raw: vi.fn((s: string) => s) },
  ),
}))

vi.mock('../lib/classifier', () => ({ classifySubscriber: mockClassify }))
vi.mock('../lib/conversation', () => ({
  buildConversationThread: vi.fn().mockResolvedValue([]),
  getLatestReply: vi.fn().mockResolvedValue(null),
}))
vi.mock('../lib/email', () => ({
  scheduleExitEmail:        mockScheduleExit,
  sendDunningEmail:         mockSendDunning,
  sendDunningFollowupEmail: mockSendDunningFollowup,
  buildFromDisplayName:     vi.fn(() => 'Test Founder'),
}))
vi.mock('../lib/events', () => ({ logEvent: mockLogEvent }))

import { runDrainTick, getPausedQueueCounts } from '../lib/pause-drain'

// ─── select-chain mock helpers ─────────────────────────────────────────────
//
// runDrainTick triggers three queue queries (cancellation/dunning/reply) in
// order, each fetching subscriber rows. Each per-row processor then issues
// its own SELECT for the customer row.
//
// We push the queue of "next return value" onto a stack and the select chain
// pops one per call. Tests push rows in the order they expect them consumed.

const selectQueue: unknown[][] = []

function enqueueSelect(rows: unknown[]) {
  selectQueue.push(rows)
}

function setupSelectMock() {
  mockSelect.mockImplementation(() => {
    const rows = selectQueue.shift() ?? []
    // .from(...).innerJoin(...).where(...).limit(...).then((rows) => ...)
    // or          .where(...)         .limit(...).then((rows) => ...)
    // The thenable terminates the chain (it's an array directly), and
    // .limit(...) also resolves directly when awaited. Drizzle's terminator
    // pattern.
    const arr = rows
    const thenable: unknown = {
      from: () => thenable,
      innerJoin: () => thenable,
      where: () => thenable,
      limit: () => ({
        then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(arr as unknown[])),
        // direct-await path (used by getPausedQueueCounts COUNT queries —
        // they don't have .limit, they await the where chain directly)
      }),
      // Direct-await path for COUNT queries (where the chain ends at .where).
      then: (cb: (r: unknown[]) => unknown) => Promise.resolve(cb(arr as unknown[])),
    }
    return thenable
  })
}

function setupUpdateChain() {
  mockUpdate.mockImplementation(() => ({
    set: () => ({
      where: () => Promise.resolve(undefined),
    }),
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.length = 0
  setupSelectMock()
  setupUpdateChain()
})

// ─── fixtures ──────────────────────────────────────────────────────────────

function fakeCancellationSubscriber(overrides: Record<string, unknown> = {}) {
  return {
    wb_churned_subscribers: {
      id: overrides.id ?? 'sub_1',
      customerId: 'cust_1',
      stripeCustomerId: 'cus_stripe_1',
      stripeSubscriptionId: 'sub_stripe_1',
      stripePriceId: 'price_1',
      email: 'subscriber@example.com',
      name: 'Carol Competitor',
      planName: 'Pro',
      mrrCents: 4900,
      tenureDays: 30,
      everUpgraded: false,
      nearRenewal: false,
      paymentFailures: 0,
      previousSubs: 0,
      stripeEnum: 'too_expensive',
      stripeComment: null,
      billingPortalClickedAt: null,
      cancelledAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      dunningTouchCount: 0,
      lastDeclineCode: null,
      nextPaymentAttemptAt: null,
      dunningState: null,
      lastEngagementAt: null,
      ...overrides,
    },
  }
}

function fakeCustomerRow() {
  return {
    id: 'cust_1',
    founderName: 'Alex Founder',
    productName: 'Acme Pro',
  }
}

function defaultClassification(over: Record<string, unknown> = {}) {
  return {
    tier: 1,
    tierReason: 't1',
    cancellationReason: 'Too expensive',
    cancellationCategory: 'Price',
    confidence: 0.9,
    suppress: false,
    firstMessage: { subject: 's', body: 'b', sendDelaySecs: 0 },
    triggerKeyword: null,
    triggerNeed: null,
    winBackSubject: 'wb',
    winBackBody: 'wbb',
    handoff: false,
    handoffReasoning: '',
    recoveryLikelihood: 'high',
    ...over,
  }
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('runDrainTick — happy path', () => {
  it('processes a cancellation: re-classifies, calls scheduleExitEmail, marks pause_drain_processed_at', async () => {
    // selectQueue order: cancellation-queue rows, dunning-queue rows, reply-
    // queue rows, then per-row processor's customer lookup.
    enqueueSelect([fakeCancellationSubscriber()])    // cancellation queue
    enqueueSelect([])                                // dunning queue (empty)
    enqueueSelect([])                                // reply queue (empty)
    enqueueSelect([fakeCustomerRow()])               // customer lookup inside processCancellationItem
    mockClassify.mockResolvedValue(defaultClassification())

    const summary = await runDrainTick(50)

    expect(summary.rowsProcessed).toBe(1)
    expect(summary.sent).toBe(1)
    expect(summary.failed).toBe(0)
    expect(mockScheduleExit).toHaveBeenCalledTimes(1)

    // pause_drain_processed_at set via markProcessed → mockUpdate called.
    // Note: the processor also persists the refreshed classification via
    // an earlier db.update() call, so we expect 2 update invocations.
    expect(mockUpdate).toHaveBeenCalledTimes(2)
  })

  it('passes daysElapsedSinceEvent to the classifier', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    enqueueSelect([fakeCancellationSubscriber({ cancelledAt: fiveDaysAgo })])
    enqueueSelect([])
    enqueueSelect([])
    enqueueSelect([fakeCustomerRow()])
    mockClassify.mockResolvedValue(defaultClassification())

    await runDrainTick(50)

    expect(mockClassify).toHaveBeenCalledWith(
      expect.objectContaining({
        daysElapsedSinceEvent: expect.any(Number),
      }),
      expect.any(Object),
    )
    const passedSignals = mockClassify.mock.calls[0][0] as { daysElapsedSinceEvent: number }
    expect(passedSignals.daysElapsedSinceEvent).toBeGreaterThanOrEqual(4)
    expect(passedSignals.daysElapsedSinceEvent).toBeLessThanOrEqual(6)
  })

  it('classifier suppress → marks pause_drain_processed_at, does NOT call scheduleExitEmail', async () => {
    enqueueSelect([fakeCancellationSubscriber()])
    enqueueSelect([])
    enqueueSelect([])
    enqueueSelect([fakeCustomerRow()])
    mockClassify.mockResolvedValue(defaultClassification({
      suppress: true,
      suppressReason: 'too stale — 90 days, missing feature decay',
      firstMessage: null,
    }))

    const summary = await runDrainTick(50)

    expect(summary.skippedClassifier).toBe(1)
    expect(summary.sent).toBe(0)
    expect(mockScheduleExit).not.toHaveBeenCalled()
    // Still marks pause_drain_processed_at (terminal outcome)
    expect(mockUpdate).toHaveBeenCalledTimes(2) // classification persist + markProcessed
  })

  it('classifier tier=4 → marks pause_drain_processed_at, does NOT call scheduleExitEmail', async () => {
    enqueueSelect([fakeCancellationSubscriber()])
    enqueueSelect([])
    enqueueSelect([])
    enqueueSelect([fakeCustomerRow()])
    mockClassify.mockResolvedValue(defaultClassification({ tier: 4, firstMessage: null }))

    const summary = await runDrainTick(50)
    expect(summary.skippedClassifier).toBe(1)
    expect(mockScheduleExit).not.toHaveBeenCalled()
  })
})

describe('runDrainTick — failure recovery (the durability guarantee)', () => {
  it('per-row classifier failure: that row stays unmarked; preceding successful rows stay marked', async () => {
    // 3 rows. Row 2 fails during classification. Rows 1 and 3 succeed.
    const r1 = fakeCancellationSubscriber({ id: 'sub_1' })
    const r2 = fakeCancellationSubscriber({ id: 'sub_2' })
    const r3 = fakeCancellationSubscriber({ id: 'sub_3' })

    enqueueSelect([r1, r2, r3]) // cancellation queue
    enqueueSelect([])           // dunning queue
    enqueueSelect([])           // reply queue
    // Per-row processors each do customer lookup, then update.
    enqueueSelect([fakeCustomerRow()]) // row 1 customer
    enqueueSelect([fakeCustomerRow()]) // row 2 customer
    enqueueSelect([fakeCustomerRow()]) // row 3 customer

    mockClassify
      .mockResolvedValueOnce(defaultClassification())
      .mockRejectedValueOnce(new Error('Anthropic 503'))
      .mockResolvedValueOnce(defaultClassification())

    const summary = await runDrainTick(50)

    expect(summary.rowsConsidered).toBe(3)
    expect(summary.sent).toBe(2)         // rows 1 + 3
    expect(summary.failed).toBe(1)       // row 2
    expect(summary.rowsProcessed).toBe(2)
    expect(mockScheduleExit).toHaveBeenCalledTimes(2)

    // mockUpdate was called for rows 1 and 3: each does 2 updates (persist
    // classification + markProcessed) = 4 total. Row 2 threw before update.
    expect(mockUpdate).toHaveBeenCalledTimes(4)
  })

  it('per-row send failure: row stays unmarked (no markProcessed) — retry-safe', async () => {
    enqueueSelect([fakeCancellationSubscriber()])
    enqueueSelect([])
    enqueueSelect([])
    enqueueSelect([fakeCustomerRow()])
    mockClassify.mockResolvedValue(defaultClassification())
    mockScheduleExit.mockRejectedValueOnce(new Error('Resend 503'))

    const summary = await runDrainTick(50)

    expect(summary.failed).toBe(1)
    expect(summary.sent).toBe(0)
    // First update fires (persist classification) but second one (markProcessed)
    // is never reached because scheduleExitEmail threw.
    expect(mockUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('runDrainTick — dunning category', () => {
  it('first dunning (touchCount=0): calls sendDunningEmail and marks processed', async () => {
    enqueueSelect([]) // cancellation queue
    enqueueSelect([fakeCancellationSubscriber({
      dunningState: 'awaiting_retry',
      dunningTouchCount: 0,
    })])
    enqueueSelect([])
    enqueueSelect([fakeCustomerRow()])

    const summary = await runDrainTick(50)

    expect(mockSendDunning).toHaveBeenCalledTimes(1)
    expect(mockSendDunningFollowup).not.toHaveBeenCalled()
    expect(summary.sent).toBe(1)
  })

  it('subsequent dunning (touchCount>0): calls sendDunningFollowupEmail', async () => {
    enqueueSelect([])
    enqueueSelect([fakeCancellationSubscriber({
      dunningState: 'final_retry_pending',
      dunningTouchCount: 1,
      nextPaymentAttemptAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })])
    enqueueSelect([])
    enqueueSelect([fakeCustomerRow()])

    const summary = await runDrainTick(50)

    expect(mockSendDunningFollowup).toHaveBeenCalledTimes(1)
    expect(mockSendDunning).not.toHaveBeenCalled()
    expect(summary.sent).toBe(1)

    const arg = mockSendDunningFollowup.mock.calls[0][0]
    expect(arg.isFinalRetry).toBe(true)
  })

  it('dunning does NOT call the classifier (template-driven)', async () => {
    enqueueSelect([])
    enqueueSelect([fakeCancellationSubscriber({
      dunningState: 'awaiting_retry',
      dunningTouchCount: 0,
    })])
    enqueueSelect([])
    enqueueSelect([fakeCustomerRow()])

    await runDrainTick(50)
    expect(mockClassify).not.toHaveBeenCalled()
  })
})
