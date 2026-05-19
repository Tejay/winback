/**
 * Spec 72 — full funnel integration test.
 *
 * Verifies the no-signal → get-signal → convert pipeline end to end at
 * the stage-transition contract level:
 *
 *   Stage 1 (classifier-tick, silent path):
 *     Row arrives with no stripeEnum / no stripeComment. Classifier-tick
 *     skips the LLM, persists tier=3, leaves triggerNeedConfidence NULL,
 *     and schedules the "asking why" exit email.
 *
 *   Stage 2 (inbound webhook, reply triggers re-classify):
 *     Subscriber replies. The classifier returns a tier-1/2 result with
 *     a concrete triggerNeed. deriveTriggerNeedConfidence flips the row
 *     to 'high'. This is the unlock.
 *
 *   Stage 3 (V2 re-engagement cron):
 *     With triggerNeedConfidence = 'high' the row passes the confidence
 *     gate and proceeds to improvement matching + send. With 'low' or a
 *     still-silent row, the gate skips it.
 *
 * Each stage uses its own mock surface (db chain mocks + LLM mocks).
 * The test asserts the column state each stage hands to the next.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ClassificationResult } from '../lib/types'

// ─── Shared mocks (hoisted so vi.mock() factories can reference them) ──
const mockSelect       = vi.hoisted(() => vi.fn())
const mockUpdate       = vi.hoisted(() => vi.fn())
const mockInsert       = vi.hoisted(() => vi.fn())
const mockClassify     = vi.hoisted(() => vi.fn())
const mockScheduleExit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockBuildThread  = vi.hoisted(() => vi.fn().mockResolvedValue([]))
const mockFindBest     = vi.hoisted(() => vi.fn())
const mockGenEmail     = vi.hoisted(() => vi.fn())
const mockSanity       = vi.hoisted(() => vi.fn())
const mockSendEmail    = vi.hoisted(() => vi.fn())
const mockIsPausedWB   = vi.hoisted(() => vi.fn().mockResolvedValue(false))
const mockIsPausedBill = vi.hoisted(() => vi.fn().mockResolvedValue(false))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate, insert: mockInsert },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: {
    id: 'id',
    customerId: 'customer_id',
    classifiedAt: 'classified_at',
    classifyAttempts: 'classify_attempts',
    createdAt: 'created_at',
    cancelledAt: 'cancelled_at',
    triggerNeedConfidence: 'trigger_need_confidence',
    status: 'status',
    email: 'email',
    doNotContact: 'do_not_contact',
    founderHandoffAt: 'founder_handoff_at',
    reengagementExpiredAt: 'reengagement_expired_at',
    lastReengagedAt: 'last_reengaged_at',
    aiPausedUntil: 'ai_paused_until',
  },
  customers: { id: 'cust_id' },
  emailsSent: { subscriberId: 'sub_id', type: 'type', sentAt: 'sent_at' },
  improvements: { customerId: 'customer_id', status: 'status' },
  improvementMatches: { subscriberId: 'sub_id', improvementId: 'imp_id' },
}))

vi.mock('drizzle-orm', () => ({
  and:       vi.fn((...args: unknown[]) => ({ and: args })),
  eq:        vi.fn((a, b) => ({ eq: [a, b] })),
  isNull:    vi.fn((a) => ({ isNull: a })),
  isNotNull: vi.fn((a) => ({ isNotNull: a })),
  inArray:   vi.fn((a, b) => ({ inArray: [a, b] })),
  asc:       vi.fn((c) => ({ asc: c })),
  desc:      vi.fn((c) => ({ desc: c })),
  lt:        vi.fn((a, b) => ({ lt: [a, b] })),
  or:        vi.fn((...a: unknown[]) => ({ or: a })),
  count:     vi.fn(() => ({ count: true })),
  sql:       Object.assign(
    (..._args: unknown[]) => ({ sql: 'mock' }),
    { raw: (s: string) => s },
  ),
}))

vi.mock('../lib/classifier', () => ({ classifySubscriber: mockClassify }))
vi.mock('../lib/email', () => ({
  scheduleExitEmail: mockScheduleExit,
  sendEmail: mockSendEmail,
  isCustomerPausedForWinback: mockIsPausedWB,
  isCustomerPausedForBillingByCustomerId: mockIsPausedBill,
  buildFromDisplayName: vi.fn(() => 'Test Founder'),
}))
vi.mock('../lib/events', () => ({ logEvent: mockLogEvent }))
vi.mock('../lib/conversation', () => ({ buildConversationThread: mockBuildThread }))

// Billing-health gate (2026-05-18) — bypass in tests; covered by
// billing-enforcement.test.ts. classifier-tick.ts now calls
// isCustomerBillingHealthy before per-row work; without this mock
// the test's mocked customer would get fail-open'd to healthy
// inconsistently and break the funnel assertions.
vi.mock('../lib/billing-enforcement', () => ({
  isCustomerBillingHealthy:               async () => true,
  isCustomerBillingHealthy_BySubscriber:  async () => true,
}))
vi.mock('../lib/improvement-match', async (orig) => {
  const actual = await orig<typeof import('../lib/improvement-match')>()
  return {
    ...actual,
    findBestMatch: mockFindBest,
    generateImprovementEmail: mockGenEmail,
    sanityCheckEmail: mockSanity,
  }
})

import { runClassifierTick } from '../lib/classifier-tick'
import { processSubscriberForReengagement } from '../lib/reengagement-cron-v2'
import { deriveTriggerNeedConfidence } from '../lib/improvement-match'

// ─── Chain helpers (match the drizzle fluent style) ────────────────────
function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
        limit: vi.fn().mockResolvedValue(rows),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
      }),
    }),
  }
}
function updateChain(returningRows: unknown[] = []) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returningRows),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      }),
    }),
  }
}
function insertChain() {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
    }),
  }
}

const RECENT = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // 5 days ago

/** Captures every UPDATE payload across the test so we can assert end state. */
type UpdateCapture = { args: Record<string, unknown>; ts: number }
function captureUpdates(): { calls: UpdateCapture[]; chain: ReturnType<typeof updateChain> } {
  const calls: UpdateCapture[] = []
  const setFn = vi.fn((args: Record<string, unknown>) => {
    calls.push({ args, ts: Date.now() })
    return {
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
      }),
    }
  })
  return { calls, chain: { set: setFn } as unknown as ReturnType<typeof updateChain> }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default: no pauses, no customer-level locks.
  mockIsPausedWB.mockResolvedValue(false)
  mockIsPausedBill.mockResolvedValue(false)
})

describe('Spec 72 — funnel: no signal → signal → re-engage', () => {

  // ─── Stage 1: classifier-tick on a silent-churn row ────────────────
  describe('Stage 1: silent-churn classified, triggerNeedConfidence stays NULL', () => {
    it('persists tier=3 and exit-email, but does NOT stamp triggerNeedConfidence', async () => {
      const silentRow = {
        id: 'sub_silent',
        customerId: 'cust_1',
        stripeCustomerId: 'cus_x',
        stripeSubscriptionId: null,
        stripePriceId: null,
        email: 'silent@example.com',
        name: 'Jamie Silent',
        planName: 'Pro',
        mrrCents: 2900,
        tenureDays: 90,
        everUpgraded: false,
        nearRenewal: false,
        paymentFailures: 0,
        previousSubs: 0,
        stripeEnum: null,    // ← silent
        stripeComment: null, // ← silent
        cancelledAt: RECENT,
        status: 'pending',
        billingPortalClickedAt: null,
      }

      const captured = captureUpdates()
      mockSelect
        .mockReturnValueOnce(selectChain([silentRow]))
        .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex', productName: 'Acme' }]))
      mockUpdate.mockReturnValue(captured.chain)

      const stats = await runClassifierTick()

      expect(stats.classified).toBe(1)
      expect(stats.exitEmailsSent).toBe(1)
      expect(mockClassify).not.toHaveBeenCalled()  // silent path skips LLM

      // The persist call (the one with `tier`) is what hands state to Stage 2.
      const persist = captured.calls.find((c) => c.args.tier !== undefined)?.args
      expect(persist).toBeDefined()
      expect(persist?.tier).toBe(3)
      expect(persist?.classifiedAt).toBeInstanceOf(Date)
      // The unlock invariant: triggerNeedConfidence MUST be absent from
      // the payload. Stage 3 derives it from stored fields on first
      // visit, but only after a reply turns it into has-signal.
      expect(persist?.triggerNeedConfidence).toBeUndefined()

      // Exit email is the "asking why" template, not a personalized win-back.
      const exitCall = mockScheduleExit.mock.calls[0][0] as {
        classification: { firstMessage: { subject: string; body: string } | null }
      }
      expect(exitCall.classification.firstMessage?.subject).toContain('A quick question')
      expect(exitCall.classification.firstMessage?.body).toContain('Acme')
    })
  })

  // ─── Stage 2: reply re-classify flips triggerNeedConfidence ────────
  describe('Stage 2: reply turns silent → has-signal', () => {
    it('a tier-2 classification with concrete triggerNeed derives "high"', () => {
      // This is what the inbound webhook's classifier returns after a
      // subscriber writes back "actually I left because you don't have
      // a Zapier integration with my CRM".
      const replyClassification: Partial<ClassificationResult> = {
        tier: 2,
        confidence: 0.9,
        cancellationReason: 'Missing Zapier integration',
        cancellationCategory: 'Feature',
        triggerKeyword: 'zapier',
        triggerNeed: 'Wants Zapier integration with their CRM',
        recoveryLikelihood: 'medium',
      }
      const tnc = deriveTriggerNeedConfidence(replyClassification as ClassificationResult)
      expect(tnc).toBe('high')  // ← the unlock for Stage 3
    })

    it('a tier-3 reply with vague text stays "low" — gate intentionally held', () => {
      const vagueReply: Partial<ClassificationResult> = {
        tier: 3,
        confidence: 0.4,
        cancellationCategory: 'Other',  // 'Other' is forced to 'low'
        triggerNeed: 'meh',  // also < 10 chars
      }
      const tnc = deriveTriggerNeedConfidence(vagueReply as ClassificationResult)
      expect(tnc).toBe('low')
    })
  })

  // ─── Stage 3: V2 cron picks up the now-eligible row ────────────────
  describe('Stage 3: V2 re-engagement processes a now-has-signal row', () => {
    const stage3Row = {
      id: 'sub_signal',
      customerId: 'cust_1',
      email: 'jamie@example.com',
      name: 'Jamie',
      status: 'pending',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: null,
      lastReengagedAt: null,
      reengagementExpiredAt: null,
      cancelledAt: RECENT,
      // Post-Stage-2 state: reply has been classified, fields persisted.
      tier: 2,
      confidence: '0.9',
      cancellationCategory: 'Feature',
      triggerNeed: 'Wants Zapier integration with their CRM',
      triggerNeedConfidence: 'high' as const,
    }

    it('high-confidence row passes the gate, matches, and sends', async () => {
      mockSelect
        .mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }])) // customer load
        .mockReturnValueOnce(selectChain([                                          // active improvements
          { id: 'imp_zapier', title: 'Zapier integration', description: 'Native Zapier app shipped', dateShipped: '2026-05-01', status: 'published', customerId: 'cust_1' },
        ]))
        .mockReturnValueOnce(selectChain([]))  // improvementMatches lookup — no prior

      mockFindBest.mockResolvedValue({
        improvement: { id: 'imp_zapier', title: 'Zapier integration', description: 'Native Zapier app shipped', dateShipped: '2026-05-01' },
        match: { confidence: 0.95, reasoning: 'exact match' },
      })
      mockGenEmail.mockResolvedValue({ subject: 'We shipped Zapier', body: 'Hi Jamie, native Zapier is live.' })
      mockSanity.mockResolvedValue({ pass: true, reason: '' })
      mockSendEmail.mockResolvedValue({ messageId: 'msg_123' })
      mockUpdate.mockReturnValue(updateChain())
      mockInsert.mockReturnValue(insertChain())

      const outcome = await processSubscriberForReengagement(stage3Row as never)
      expect(outcome.kind).toBe('emailed')
      if (outcome.kind === 'emailed') {
        expect(outcome.improvementId).toBe('imp_zapier')
      }
      expect(mockSendEmail).toHaveBeenCalled()
    })

    it('low-confidence row gets skipped at the confidence gate', async () => {
      const lowRow = { ...stage3Row, triggerNeedConfidence: 'low' as const }
      mockSelect.mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
      mockUpdate.mockReturnValue(updateChain())

      const outcome = await processSubscriberForReengagement(lowRow as never)
      expect(outcome.kind).toBe('skipped')
      if (outcome.kind === 'skipped') {
        expect(outcome.reason).toBe('low_confidence')
      }
      expect(mockSendEmail).not.toHaveBeenCalled()
    })

    it('still-silent row (NULL confidence, no triggerNeed) — V2 derives "low" + skips', async () => {
      // The classic "silent churn never replied" case. classifier-tick
      // left triggerNeedConfidence NULL. V2 derives from stored fields
      // (Other category + low confidence + no triggerNeed) → 'low'.
      const stillSilentRow = {
        ...stage3Row,
        tier: 3,
        confidence: '0.3',
        cancellationCategory: 'Other',
        triggerNeed: null,
        triggerNeedConfidence: null,
      }
      const captured = captureUpdates()
      mockSelect.mockReturnValueOnce(selectChain([{ id: 'cust_1', founderName: 'Alex' }]))
      mockUpdate.mockReturnValue(captured.chain)

      const outcome = await processSubscriberForReengagement(stillSilentRow as never)

      // The derive-and-persist UPDATE should have stamped 'low'.
      const derivePersist = captured.calls.find((c) => c.args.triggerNeedConfidence !== undefined)?.args
      expect(derivePersist?.triggerNeedConfidence).toBe('low')

      expect(outcome.kind).toBe('skipped')
      if (outcome.kind === 'skipped') {
        expect(outcome.reason).toBe('low_confidence')
      }
      expect(mockSendEmail).not.toHaveBeenCalled()
    })
  })

  // ─── End-to-end stitch: state flows from Stage 1 → 2 → 3 ───────────
  describe('end-to-end: row state threads through the three stages', () => {
    it('silent row → classified (NULL) → reply derives high → V2 sends', async () => {
      // Stage 1: classifier-tick persists tier=3, no triggerNeedConfidence.
      const silentRow = {
        id: 'sub_e2e',
        customerId: 'cust_e2e',
        stripeCustomerId: 'cus_e2e',
        stripeSubscriptionId: null,
        stripePriceId: null,
        email: 'e2e@example.com',
        name: 'E2E Tester',
        planName: 'Pro',
        mrrCents: 2900,
        tenureDays: 60,
        everUpgraded: false,
        nearRenewal: false,
        paymentFailures: 0,
        previousSubs: 0,
        stripeEnum: null,
        stripeComment: null,
        cancelledAt: RECENT,
        status: 'pending',
        billingPortalClickedAt: null,
      }
      const stage1Cap = captureUpdates()
      mockSelect
        .mockReturnValueOnce(selectChain([silentRow]))
        .mockReturnValueOnce(selectChain([{ id: 'cust_e2e', founderName: 'E', productName: 'P' }]))
      mockUpdate.mockReturnValue(stage1Cap.chain)
      await runClassifierTick()

      const stage1Persist = stage1Cap.calls.find((c) => c.args.tier !== undefined)?.args
      expect(stage1Persist?.tier).toBe(3)
      expect(stage1Persist?.triggerNeedConfidence).toBeUndefined()

      // Stage 2: simulate inbound re-classify after subscriber replies.
      const replyClassification: Partial<ClassificationResult> = {
        tier: 1,
        confidence: 0.85,
        cancellationCategory: 'Price',
        triggerNeed: 'Wants a cheaper tier under $20/month for solo use',
      }
      const newTnc = deriveTriggerNeedConfidence(replyClassification as ClassificationResult)
      expect(newTnc).toBe('high')

      // Stage 3: feed the post-reply row state into V2.
      vi.clearAllMocks()
      const postReplyRow = {
        ...silentRow,
        tier: 1,
        confidence: '0.85',
        cancellationCategory: 'Price',
        triggerNeed: 'Wants a cheaper tier under $20/month for solo use',
        triggerNeedConfidence: 'high' as const,
        doNotContact: false,
        founderHandoffAt: null,
        founderHandoffResolvedAt: null,
        aiPausedUntil: null,
        lastReengagedAt: null,
        reengagementExpiredAt: null,
      }
      mockIsPausedWB.mockResolvedValue(false)
      mockIsPausedBill.mockResolvedValue(false)
      mockSelect
        .mockReturnValueOnce(selectChain([{ id: 'cust_e2e', founderName: 'E' }]))
        .mockReturnValueOnce(selectChain([
          { id: 'imp_starter', title: 'Starter tier', description: '$15/month starter', dateShipped: '2026-05-01', status: 'published', customerId: 'cust_e2e' },
        ]))
        .mockReturnValueOnce(selectChain([]))
      mockFindBest.mockResolvedValue({
        improvement: { id: 'imp_starter', title: 'Starter tier', description: '$15/month starter', dateShipped: '2026-05-01' },
        match: { confidence: 0.92, reasoning: 'price match' },
      })
      mockGenEmail.mockResolvedValue({ subject: 'New $15 tier', body: 'Hi.' })
      mockSanity.mockResolvedValue({ pass: true, reason: '' })
      mockSendEmail.mockResolvedValue({ messageId: 'msg_e2e' })
      mockUpdate.mockReturnValue(updateChain())
      mockInsert.mockReturnValue(insertChain())

      const outcome = await processSubscriberForReengagement(postReplyRow as never)
      expect(outcome.kind).toBe('emailed')
    })
  })
})
