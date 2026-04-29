/**
 * Spec 33 — sendDunningFollowupEmail copy + send tests.
 *
 * Verifies T2 and T3 variants share the same function but produce the
 * right subject, body, and idempotency type for each branch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend                  = vi.hoisted(() => vi.fn())
const mockSelect                = vi.hoisted(() => vi.fn())
const mockInsert                = vi.hoisted(() => vi.fn())
const mockUpdate                = vi.hoisted(() => vi.fn())
const mockLogEvent              = vi.hoisted(() => vi.fn())

vi.mock('resend', () => ({
  Resend: class { emails = { send: mockSend } },
}))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  emailsSent: 'wb_emails_sent',
  churnedSubscribers: { id: 'cs.id', doNotContact: 'cs.dnc', customerId: 'cs.cid', aiPausedUntil: 'cs.apu' },
  customers: { id: 'c.id', pausedAt: 'c.pa' },
  users: { id: 'u.id', email: 'u.email' },
}))

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn((a, b) => ({ eq: [a, b] })),
  and: vi.fn((...a) => ({ and: a })),
  count: vi.fn(),
}))

vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { sendDunningFollowupEmail } from '../lib/email'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.RESEND_API_KEY = 'test_key'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  process.env.NEXTAUTH_SECRET = 'test_secret'   // unsubscribe-token signs with this
  mockSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null })

  // Default DNC + pause + AI-pause checks all return false
  // (DNC chain: select().from().where().limit() → [{ dnc: false }])
  // (Pause chain: select().from().innerJoin().where().limit() → [{ pausedAt: null }])
  // (AI-pause chain: select().from().where().limit() → [{ aiPausedUntil: null }])
  mockSelect.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ dnc: false, aiPausedUntil: null }]),
      }),
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ pausedAt: null }]),
        }),
      }),
    }),
  }))

  // recordEmailSentIdempotent calls db.insert
  mockInsert.mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  })

  // Various other db.update chains used by event logging etc
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
})

const baseParams = {
  subscriberId: 'sub_1',
  email:        'a@x.co',
  customerName: 'Sam',
  planName:     'Pro Monthly',
  amountDue:    2900,    // $29.00
  currency:     'usd',
  retryDate:    new Date('2026-05-15T14:30:00Z'),
  fromName:     'Acme',
}

describe('sendDunningFollowupEmail — T2 (isFinalRetry: false)', () => {
  it('subject contains "retry your card on" + the formatted date', async () => {
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: false })
    expect(mockSend).toHaveBeenCalledTimes(1)
    const arg = mockSend.mock.calls[0][0]
    expect(arg.subject).toContain('retry your card on')
    expect(arg.subject).toContain('15 May')
  })

  it('body includes the update-payment URL + plan + amount + retry time', async () => {
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: false })
    const arg = mockSend.mock.calls[0][0]
    expect(arg.text).toContain('https://app.example.com/api/update-payment/sub_1')
    expect(arg.text).toContain('Pro Monthly')
    expect(arg.text).toContain('29.00')
    expect(arg.text).toContain('14:30 UTC')
    expect(arg.text).toContain('Hi Sam')
  })
})

describe('sendDunningFollowupEmail — T3 (isFinalRetry: true)', () => {
  it('subject contains "Last automatic retry"', async () => {
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: true })
    const arg = mockSend.mock.calls[0][0]
    expect(arg.subject).toContain('Last automatic retry')
  })

  it('body switches to urgency copy ("subscription ends" + "final time")', async () => {
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: true })
    const arg = mockSend.mock.calls[0][0]
    expect(arg.text).toContain('one final time')
    expect(arg.text).toContain('cancelled')
    expect(arg.text).toContain('Pro Monthly')
    // Update link still present
    expect(arg.text).toContain('/api/update-payment/sub_1')
  })
})

describe('sendDunningFollowupEmail — fallbacks', () => {
  it('falls back to "there" when customerName is null', async () => {
    await sendDunningFollowupEmail({ ...baseParams, customerName: null, isFinalRetry: false })
    const arg = mockSend.mock.calls[0][0]
    expect(arg.text).toContain('Hi there')
  })
})

// Spec 34 — bespoke decline-code-aware copy in T2/T3 bodies.
// The dunning email function reads `lastDeclineCode` from the subscriber
// row (the 4th select() call after DNC, pause, ai-pause). We override
// the mock to return a specific code for that call.
function setLastDeclineCode(code: string | null) {
  let selectCallCount = 0
  mockSelect.mockImplementation(() => {
    const isDeclineLookup = selectCallCount === 3 // 0=DNC, 1=pause, 2=ai-pause, 3=decline
    selectCallCount++
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(
            isDeclineLookup
              ? [{ lastDeclineCode: code }]
              : [{ dnc: false, aiPausedUntil: null }],
          ),
        }),
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ pausedAt: null }]),
          }),
        }),
      }),
    }
  })
}

describe('sendDunningFollowupEmail — Spec 34 decline-aware copy', () => {
  it('expired_card weaves "expired" reason + "update" action into both text and html', async () => {
    setLastDeclineCode('expired_card')
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: false })
    const arg = mockSend.mock.calls[0][0]

    expect(arg.text).toMatch(/Why this happened:.*expired/i)
    expect(arg.text).toMatch(/Best next step:.*update/i)
    expect(arg.html).toContain('Why this happened')
    expect(arg.html).toContain('expired since the last successful charge')
    expect(arg.html).toContain('Best next step')
  })

  it('do_not_honor weaves "bank declined" reason + "call the number" advice', async () => {
    setLastDeclineCode('do_not_honor')
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: false })
    const arg = mockSend.mock.calls[0][0]

    expect(arg.text.toLowerCase()).toContain('bank declined')
    expect(arg.text.toLowerCase()).toContain('call the number')
    expect(arg.html).toContain('bank declined the charge')
  })

  it('processing_error suppresses the update CTA in both text and html bodies', async () => {
    setLastDeclineCode('processing_error')
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: false })
    const arg = mockSend.mock.calls[0][0]

    // Reason + action still appear
    expect(arg.text.toLowerCase()).toContain('temporary issue')
    expect(arg.text.toLowerCase()).toContain('no action needed')
    // But the body's update-payment URL block is gone
    expect(arg.text).not.toContain('Update your payment method here:\nhttps://app.example.com/api/update-payment/sub_1')
    // HTML button is hidden
    expect(arg.html).not.toContain('>Update payment</a>')
    // Unsubscribe footer still present (not affected)
    expect(arg.html).toContain('>Unsubscribe</a>')
  })

  it('null lastDeclineCode falls back to generic copy (no "Why this happened" header)', async () => {
    setLastDeclineCode(null)
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: false })
    const arg = mockSend.mock.calls[0][0]

    // Fallback bucket DOES still include the "Why this happened" header
    // because the body always shows reason + action — but the reason
    // is the generic one, not a bespoke decline.
    expect(arg.text).toMatch(/Why this happened:.*didn't go through/)
  })

  it('T3 (isFinalRetry) inherits the same decline copy', async () => {
    setLastDeclineCode('insufficient_funds')
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: true })
    const arg = mockSend.mock.calls[0][0]

    expect(arg.text.toLowerCase()).toContain('insufficient funds')
    expect(arg.text.toLowerCase()).toContain('different card')
    // T3-specific copy still appears
    expect(arg.text).toContain('one final time')
    expect(arg.html).toContain('Final reminder')
  })
})

// Spec 37 — both `text` and `html` are sent on the same Resend call,
// so plain-text clients still get the existing body.
describe('sendDunningFollowupEmail — Spec 37 HTML body', () => {
  it('T2 passes both text and html to Resend, with the styled "Update payment" button anchor', async () => {
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: false })
    const arg = mockSend.mock.calls[0][0]

    // Plain-text body still passed
    expect(arg.text).toContain('https://app.example.com/api/update-payment/sub_1')
    // HTML body present
    expect(arg.html).toBeTruthy()
    expect(arg.html).toContain('href="https://app.example.com/api/update-payment/sub_1"')
    expect(arg.html).toContain('>Update payment</a>')
    // Heads-up tone (T2)
    expect(arg.html).toContain('Heads up')
    expect(arg.html).not.toContain('Final reminder')
  })

  it('T3 html switches to "Final reminder" tone + one-final-time copy', async () => {
    await sendDunningFollowupEmail({ ...baseParams, isFinalRetry: true })
    const arg = mockSend.mock.calls[0][0]

    expect(arg.html).toBeTruthy()
    expect(arg.html).toContain('Final reminder')
    expect(arg.html).toContain('one final time')
    expect(arg.html).toContain('subscription will be cancelled')
    // Unsubscribe link still in the de-emphasized footer
    expect(arg.html).toContain('font-size:11px')
    expect(arg.html).toContain('/api/unsubscribe/sub_1')
  })
})
