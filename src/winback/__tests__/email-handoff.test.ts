/**
 * Tests for the AI-decided hand-off pipeline in email.ts:
 *
 *   - sendReplyEmail with classification.handoff === true
 *       → hands off, notifies the founder, does NOT send an AI follow-up.
 *   - sendReplyEmail with classification.handoff === false and follow-ups remaining
 *       → sends an AI follow-up, persists reasoning + likelihood for audit.
 *   - sendReplyEmail with classification.handoff === false and follow-up budget exhausted
 *       → silently closes the subscriber as 'lost' with NO founder notification.
 *   - scheduleExitEmail with classification.handoff === true
 *       → skips the exit email, hands off immediately, burns 0 of the 3-email budget.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  emailsSent:        { subscriberId: 'sub_id', type: 'type' },
  churnedSubscribers: { id: 'id', customerId: 'customer_id', doNotContact: 'dnc', aiPausedUntil: 'paused' },
  customers:         { id: 'customer_id_col', pausedAt: 'paused_at', notificationEmail: 'notif_email', userId: 'user_id' },
  users:             { id: 'user_id_col', email: 'email' },
}))

vi.mock('drizzle-orm', () => ({
  eq:    vi.fn((a, b) => ({ a, b })),
  and:   vi.fn((...args) => ({ and: args })),
  count: vi.fn(() => ({ count: true })),
}))

// Hoisted mock for logEvent so we don't hit the events DB path in tests.
const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('../lib/events', () => ({ logEvent: mockLogEvent }))

// Stub founder-handoff-email to avoid pulling its DB-backed conversation loader.
const mockBuildHandoffNotification = vi.hoisted(() => vi.fn().mockResolvedValue({
  subject: '[Winback] Action needed — subscriber',
  body:    'Hi founder,\n\nRecovery likelihood: HIGH\nWhy I am handing off: ...',
}))
vi.mock('../lib/founder-handoff-email', () => ({
  buildHandoffNotification: mockBuildHandoffNotification,
}))

import { sendReplyEmail, scheduleExitEmail } from '../lib/email'
import { ClassificationResult } from '../lib/types'

// ---------------------------------------------------------------------------
// Queue-based select mock — each test pushes the sequence of rows its call
// path will trigger, in order. Keeps individual tests readable while still
// exercising the real query chain in email.ts.
// ---------------------------------------------------------------------------

const selectQueue: unknown[][] = []

function enqueueSelect(rows: unknown[]) {
  selectQueue.push(rows)
}

function setupSelectMock() {
  mockSelect.mockImplementation(() => {
    const rows = selectQueue.shift() ?? []
    const thenable = {
      // .limit(n) — direct terminator
      limit: vi.fn().mockResolvedValue(rows),
      // .orderBy(...).limit(n) — ordered terminator
      orderBy: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
      // Some queries await the builder directly without .limit() (count queries).
      // Make the builder itself thenable.
      then: (cb: (v: unknown[]) => unknown) => Promise.resolve(rows).then(cb),
    }
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue(thenable),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(thenable),
        }),
      }),
    }
  })
}

function baseClassification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    tier: 1,
    tierReason: 'test',
    cancellationReason: 'Wants enterprise pricing',
    cancellationCategory: 'Price',
    confidence: 0.9,
    suppress: false,
    firstMessage: { subject: 'About your plan', body: 'Body goes here.', sendDelaySecs: 60 },
    triggerKeyword: null,
    triggerNeed: null,
    winBackSubject: '',
    winBackBody: '',
    handoff: false,
    handoffReasoning: '',
    recoveryLikelihood: 'low',
    ...overrides,
  }
}

const subscriberRow = {
  id: 'sub_1',
  customerId: 'cust_1',
  email: 'sarah@example.com',
  name: 'Sarah',
  planName: 'Pro',
  mrrCents: 4900,
  cancellationReason: 'pricing',
  triggerNeed: null,
  cancelledAt: new Date('2026-04-01'),
  stripeComment: null,
  replyText: 'Can I talk to your founder?',
  founderHandoffAt: null,
  aiPausedUntil: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.length = 0
  process.env.NEXTAUTH_SECRET = 'test-secret-for-hmac-signing'
  process.env.NEXT_PUBLIC_APP_URL = 'https://winbackflow.co'
  process.env.RESEND_API_KEY = 'rs_test'
  setupSelectMock()
  mockSend.mockResolvedValue({ data: { id: 'msg_123' }, error: null })
  mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue([]) })
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  })
})

describe('sendReplyEmail — AI decides to hand off', () => {
  it('hands off to founder, notifies, and does NOT send an AI follow-up', async () => {
    // Gates: not DNC, not customer-paused, not ai-paused.
    enqueueSelect([{ dnc: false }])                                   // isDoNotContact
    enqueueSelect([{ pausedAt: null }])                               // isCustomerPausedForSubscriber
    enqueueSelect([{ aiPausedUntil: null }])                          // isAiPaused
    // triggerFounderHandoff: full subscriber row, then recipient lookup.
    enqueueSelect([subscriberRow])                                    // SELECT * FROM churnedSubscribers
    enqueueSelect([{ notificationEmail: null, userEmail: 'founder@example.com' }])

    const result = await sendReplyEmail({
      subscriberId: 'sub_1',
      email: 'sarah@example.com',
      classification: baseClassification({
        handoff: true,
        handoffReasoning: 'They explicitly asked to speak to the founder about pricing — a personal reply has a real shot.',
        recoveryLikelihood: 'high',
      }),
      fromName: 'Alex',
    })

    expect(result).toEqual({ sent: false, reason: 'ai_handoff' })

    // Exactly one Resend call — the handoff notification to the founder,
    // NOT an AI follow-up to the subscriber.
    expect(mockSend).toHaveBeenCalledTimes(1)
    const sendArgs = mockSend.mock.calls[0][0]
    expect(sendArgs.to).toBe('founder@example.com')
    expect(sendArgs.from).toContain('noreply@winbackflow.co')

    // Handoff notification was built with the AI's reasoning + likelihood.
    expect(mockBuildHandoffNotification).toHaveBeenCalledTimes(1)
    const [notifArgs] = mockBuildHandoffNotification.mock.calls[0]
    expect(notifArgs.handoffReasoning).toContain('personal reply')
    expect(notifArgs.recoveryLikelihood).toBe('high')

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'founder_handoff_triggered',
    }))
  })
})

describe('sendReplyEmail — AI says no hand-off, budget remaining', () => {
  it('sends the AI follow-up and persists reasoning + likelihood', async () => {
    enqueueSelect([{ dnc: false }])                // isDoNotContact
    enqueueSelect([{ pausedAt: null }])            // isCustomerPausedForSubscriber
    enqueueSelect([{ aiPausedUntil: null }])       // isAiPaused
    enqueueSelect([{ total: 1 }])                  // followup count — 1 sent, 1 remaining
    enqueueSelect([{ messageId: 'msg_orig' }])     // originalEmail lookup

    const result = await sendReplyEmail({
      subscriberId: 'sub_1',
      email: 'sarah@example.com',
      classification: baseClassification({
        handoff: false,
        handoffReasoning: 'Reply is vague — AI can still try one more targeted message.',
        recoveryLikelihood: 'medium',
        firstMessage: { subject: 'About your feedback', body: 'Thanks for the reply.', sendDelaySecs: 60 },
      }),
      fromName: 'Alex',
    })

    expect(result).toEqual({ sent: true })

    // Exactly one Resend call — the AI follow-up to the subscriber.
    expect(mockSend).toHaveBeenCalledTimes(1)
    const sendArgs = mockSend.mock.calls[0][0]
    expect(sendArgs.to).toBe('sarah@example.com')

    // No hand-off notification should be built.
    expect(mockBuildHandoffNotification).not.toHaveBeenCalled()

    // We persisted the AI's per-pass judgment via db.update.
    expect(mockUpdate).toHaveBeenCalled()
    const setCalls = mockUpdate.mock.results.flatMap(r => (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls)
    const persisted = setCalls.find(args =>
      (args[0] as { handoffReasoning?: string }).handoffReasoning?.includes('targeted message'),
    )
    expect(persisted).toBeDefined()
  })
})

describe('sendReplyEmail — AI says no hand-off, budget exhausted', () => {
  it('silently closes as lost and does NOT notify the founder', async () => {
    enqueueSelect([{ dnc: false }])                // isDoNotContact
    enqueueSelect([{ pausedAt: null }])            // isCustomerPausedForSubscriber
    enqueueSelect([{ aiPausedUntil: null }])       // isAiPaused
    enqueueSelect([{ total: 2 }])                  // followup count — already at cap

    const result = await sendReplyEmail({
      subscriberId: 'sub_1',
      email: 'sarah@example.com',
      classification: baseClassification({
        handoff: false,
        handoffReasoning: 'Dead thread — no engagement since first reply.',
        recoveryLikelihood: 'low',
      }),
      fromName: 'Alex',
    })

    expect(result).toEqual({ sent: false, reason: 'budget_exhausted' })

    // No email of any kind goes out — not to the subscriber, not to the founder.
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockBuildHandoffNotification).not.toHaveBeenCalled()

    // Status was set to 'lost' and reasoning persisted.
    const setCalls = mockUpdate.mock.results.flatMap(r => (r.value as { set: ReturnType<typeof vi.fn> }).set.mock.calls)
    const lostUpdate = setCalls.find(args => (args[0] as { status?: string }).status === 'lost')
    expect(lostUpdate).toBeDefined()
    expect((lostUpdate?.[0] as { handoffReasoning?: string }).handoffReasoning).toContain('Dead thread')

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'subscriber_auto_lost',
    }))
  })
})

describe('scheduleExitEmail — AI decides initial hand-off', () => {
  it('skips the exit email and hands off before any AI email is sent', async () => {
    // scheduleExitEmail gates: DNC, customer-paused, ai-paused — in that order.
    enqueueSelect([{ dnc: false }])                         // isDoNotContact
    enqueueSelect([{ pausedAt: null }])                     // isCustomerPausedForSubscriber
    enqueueSelect([{ aiPausedUntil: null }])                // isAiPaused
    // Then triggerFounderHandoff path:
    enqueueSelect([subscriberRow])                          // SELECT subscriber
    enqueueSelect([{ notificationEmail: null, userEmail: 'founder@example.com' }])

    await scheduleExitEmail({
      subscriberId: 'sub_1',
      email: 'sarah@example.com',
      classification: baseClassification({
        handoff: true,
        handoffReasoning: 'Enterprise-pricing ask in stripe_comment — needs a business decision from you.',
        recoveryLikelihood: 'high',
      }),
      fromName: 'Alex',
    })

    // Exactly one Resend call — the handoff notification. The exit email was
    // skipped. No 'contacted' status update either (the AI burned 0 email
    // budget slots).
    expect(mockSend).toHaveBeenCalledTimes(1)
    const sendArgs = mockSend.mock.calls[0][0]
    expect(sendArgs.to).toBe('founder@example.com')
    expect(sendArgs.from).toContain('noreply@winbackflow.co')

    expect(mockBuildHandoffNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffReasoning: expect.stringContaining('business decision'),
        recoveryLikelihood: 'high',
      }),
    )
  })
})
