import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Spec 63 sweep A — integration coverage for the gate stack inside
 * `scheduleExitEmail`. Each gate is unit-tested in isolation by
 * `billing-pause-gate.test.ts`, `ai-pause.test.ts`, and `email.test.ts`,
 * but no test exercises them *together* through the actual send path.
 *
 * This file:
 *   1. Confirms each gate blocks the send (no Resend call, no email_sent row,
 *      no status flip to 'contacted').
 *   2. Confirms the documented short-circuit order. The implementation
 *      gates in this order: firstMessage:null > DNC > winback-paused >
 *      billing-paused > AI-paused > classifier-handoff > send. We assert
 *      the order by observing which gates are queried before short-circuit.
 *   3. Confirms the only gate that emits a `wb_events` row today is
 *      billing-pause (`send_skipped_billing_pause`). The others are silent
 *      skips. If observability is added to the others, this test should
 *      fail and be updated.
 */

const mockSend = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend }
  },
}))

const mockSelect = vi.hoisted(() => vi.fn())
const mockInsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  },
}))

vi.mock('@/lib/schema', () => ({
  emailsSent: 'wb_emails_sent',
  churnedSubscribers: {
    doNotContact: 'do_not_contact',
    id: 'id',
    customerId: 'customer_id',
    aiPausedUntil: 'ai_paused_until',
    founderHandoffAt: 'founder_handoff_at',
  },
  customers: {
    id: 'customer_id_col',
    pausedAt: 'paused_at',
    activatedAt: 'activated_at',
    stripeSubscriptionId: 'stripe_subscription_id',
    pilotUntil: 'pilot_until',
  },
  users: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ a, b })),
  count: vi.fn(() => 'count_marker'),
}))

const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

// Billing-health gate (2026-05-18) — bypass so these gate-order tests
// stay focused on the gates they exercise. Behaviour of the new gate
// is covered by billing-enforcement.test.ts.
// Plain async functions (not vi.fn) — vi.resetAllMocks() in the
// beforeEach would otherwise wipe the resolved value back to undefined,
// breaking the gate-clear baseline.
vi.mock('../lib/billing-enforcement', () => ({
  isCustomerBillingHealthy:               async () => true,
  isCustomerBillingHealthy_BySubscriber:  async () => true,
}))

const mockResolveFounderEmail = vi.hoisted(() => vi.fn().mockResolvedValue(null))
const mockBuildHandoffNotification = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ subject: 'handoff', body: 'body' }),
)
vi.mock('../lib/founder-handoff-email', () => ({
  buildHandoffNotification: mockBuildHandoffNotification,
}))

import { scheduleExitEmail } from '../lib/email'
import { ClassificationResult } from '../lib/types'

/**
 * Queue of canned rows. Each call to `.limit()` (the terminal of every
 * gate's drizzle chain) shifts the next response. Tests queue responses
 * in the documented gate order:
 *   1. isDoNotContact         → [{ dnc }]
 *   2. isCustomerPausedForWinback → [{ pausedAt }]
 *   3. isCustomerPausedForBilling → [{ activatedAt, stripeSubscriptionId, pilotUntil }]
 *   4. isAiPaused             → [{ aiPausedUntil }]
 *   (then sendEmail re-checks DNC + AI-paused, or triggerFounderHandoff reads the subscriber row)
 */
let queuedRows: unknown[][] = []
function queueRow(row: unknown) {
  queuedRows.push([row])
}
function queueAllClear() {
  queueRow({ dnc: false })
  queueRow({ pausedAt: null })
  queueRow({ activatedAt: null, stripeSubscriptionId: null, pilotUntil: null })
  queueRow({ aiPausedUntil: null })
  // sendEmail re-checks DNC + AI-paused inside itself
  queueRow({ dnc: false })
  queueRow({ aiPausedUntil: null })
}

beforeEach(() => {
  vi.resetAllMocks()
  queuedRows = []
  process.env.NEXTAUTH_SECRET = 'test-secret-for-hmac-signing'
  process.env.NEXT_PUBLIC_APP_URL = 'https://winbackflow.co'

  mockSend.mockResolvedValue({ data: { id: 'msg_test' }, error: null })

  mockSelect.mockImplementation(() => {
    const limitFn = vi.fn().mockImplementation(() =>
      Promise.resolve(queuedRows.shift() ?? []),
    )
    const whereChain = { where: vi.fn().mockReturnValue({ limit: limitFn }) }
    return {
      from: vi.fn().mockReturnValue({
        // chain A: select().from().where().limit() — DNC, AI-paused
        where: vi.fn().mockReturnValue({ limit: limitFn }),
        // chain B: select().from().innerJoin().where().limit() — winback-paused, billing-paused
        innerJoin: vi.fn().mockReturnValue(whereChain),
      }),
    }
  })

  mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) })
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })

  mockResolveFounderEmail.mockResolvedValue(null)
})

const baseClassification: ClassificationResult = {
  tier: 1,
  tierReason: '',
  confidence: 0.9,
  triggerKeyword: '',
  triggerNeed: '',
  cancellationReason: 'too expensive',
  cancellationCategory: 'price',
  winBackSubject: '',
  winBackBody: '',
  firstMessage: { subject: 'hey', body: 'hi there. what would have made it worth it?', sendDelaySecs: 0 },
  handoff: false,
  handoffReasoning: '',
  recoveryLikelihood: 'medium',
  suppress: false,
}

describe('scheduleExitEmail — gate precedence', () => {
  it('baseline: all gates clear → email is sent and row is inserted', async () => {
    queueAllClear()

    await scheduleExitEmail({
      subscriberId: 'sub_clear',
      email: 'sub@example.com',
      classification: baseClassification,
      fromName: 'Alex',
    })

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalled()
    // status flip to 'contacted'
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('firstMessage:null short-circuits before any DB call', async () => {
    const suppressed: ClassificationResult = {
      ...baseClassification,
      tier: 4,
      firstMessage: null,
    }

    await scheduleExitEmail({
      subscriberId: 'sub_suppress',
      email: 'sub@example.com',
      classification: suppressed,
      fromName: 'Alex',
    })

    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('DNC blocks before any later gate is queried', async () => {
    queueRow({ dnc: true })

    await scheduleExitEmail({
      subscriberId: 'sub_dnc',
      email: 'sub@example.com',
      classification: baseClassification,
      fromName: 'Alex',
    })

    expect(mockSend).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    // Only the DNC select fires — winback / billing / AI-paused are never queried.
    expect(mockSelect).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('winback-pause blocks after DNC, before billing/ai/handoff', async () => {
    queueRow({ dnc: false })
    queueRow({ pausedAt: new Date('2026-04-01') })

    await scheduleExitEmail({
      subscriberId: 'sub_winback_paused',
      email: 'sub@example.com',
      classification: baseClassification,
      fromName: 'Alex',
    })

    expect(mockSend).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockSelect).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('billing-pause blocks after winback-pause and emits send_skipped_billing_pause', async () => {
    queueRow({ dnc: false })
    queueRow({ pausedAt: null })
    queueRow({
      activatedAt: new Date('2026-04-01'),
      stripeSubscriptionId: null,
      pilotUntil: null,
    })

    await scheduleExitEmail({
      subscriberId: 'sub_billing_paused',
      email: 'sub@example.com',
      classification: baseClassification,
      fromName: 'Alex',
    })

    expect(mockSend).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockSelect).toHaveBeenCalledTimes(3)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'send_skipped_billing_pause',
        properties: expect.objectContaining({
          subscriberId: 'sub_billing_paused',
          emailType: 'exit',
        }),
      }),
    )
  })

  it('billing-pause is bypassed when pilot is active (pilotUntil > now)', async () => {
    queueRow({ dnc: false })
    queueRow({ pausedAt: null })
    queueRow({
      activatedAt: new Date('2026-04-01'),
      stripeSubscriptionId: null,
      // Pilot active for another year — billing pause should NOT trigger.
      pilotUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    })
    queueRow({ aiPausedUntil: null })
    // sendEmail's internal re-checks
    queueRow({ dnc: false })
    queueRow({ aiPausedUntil: null })

    await scheduleExitEmail({
      subscriberId: 'sub_pilot',
      email: 'sub@example.com',
      classification: baseClassification,
      fromName: 'Alex',
    })

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalled()
  })

  it('AI-pause blocks after billing-pause check, before handoff/send', async () => {
    queueRow({ dnc: false })
    queueRow({ pausedAt: null })
    queueRow({ activatedAt: null, stripeSubscriptionId: null, pilotUntil: null })
    queueRow({ aiPausedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) })

    await scheduleExitEmail({
      subscriberId: 'sub_ai_paused',
      email: 'sub@example.com',
      classification: baseClassification,
      fromName: 'Alex',
    })

    expect(mockSend).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockSelect).toHaveBeenCalledTimes(4)
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('an AI-paused-until date in the past does NOT trip the gate', async () => {
    queueRow({ dnc: false })
    queueRow({ pausedAt: null })
    queueRow({ activatedAt: null, stripeSubscriptionId: null, pilotUntil: null })
    queueRow({ aiPausedUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) })
    queueRow({ dnc: false })
    queueRow({ aiPausedUntil: new Date(Date.now() - 24 * 60 * 60 * 1000) })

    await scheduleExitEmail({
      subscriberId: 'sub_ai_pause_expired',
      email: 'sub@example.com',
      classification: baseClassification,
      fromName: 'Alex',
    })

    expect(mockSend).toHaveBeenCalledTimes(1)
  })
})
