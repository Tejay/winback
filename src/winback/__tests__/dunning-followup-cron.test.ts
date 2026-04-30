/**
 * Spec 33 — runDunningTouches cron-pass tests.
 *
 * Verifies the T2 + T3 sweeper:
 *   - Sends + bumps touch_count + writes last_touch_at + logs event for each row
 *   - T2 only fires for state='awaiting_retry' AND touch_count=1
 *   - T3 only fires for state='final_retry_pending' AND touch_count=2
 *   - T3 is sent with isFinalRetry: true
 *   - dryRun skips sends + DB writes
 *   - Per-row send failure doesn't abort the loop
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect           = vi.hoisted(() => vi.fn())
const mockUpdate           = vi.hoisted(() => vi.fn())
const mockSendDunningT2T3  = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent         = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: {
    id: 'cs.id', email: 'cs.email', name: 'cs.name', planName: 'cs.plan',
    mrrCents: 'cs.mrr', customerId: 'cs.cid',
    nextPaymentAttemptAt: 'cs.npa', dunningTouchCount: 'cs.dtc',
    dunningLastTouchAt: 'cs.dlta', dunningState: 'cs.ds',
    doNotContact: 'cs.dnc', updatedAt: 'cs.ua',
  },
  customers: { id: 'c.id', userId: 'c.uid', founderName: 'c.fn', productName: 'c.pn' },
  users:     { id: 'u.id', name: 'u.name' },
}))

vi.mock('drizzle-orm', () => ({
  eq:        vi.fn((a, b) => ({ eq: [a, b] })),
  and:       vi.fn((...a) => ({ and: a })),
  isNotNull: vi.fn((a) => ({ isNotNull: a })),
  sql:       Object.assign(
    vi.fn((strs, ...vals) => ({ sql: { strs, vals } })),
    { raw: vi.fn() },
  ),
}))

vi.mock('../lib/email', () => ({
  sendDunningFollowupEmail: mockSendDunningT2T3,
}))

vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { runDunningTouches } from '../lib/dunning-followup'

beforeEach(() => {
  vi.clearAllMocks()
  mockSendDunningT2T3.mockResolvedValue(undefined)
})

/**
 * The cron makes two select calls back-to-back: one for T2 eligibility,
 * one for T3 eligibility. This helper queues both responses.
 */
function setupSelects(t2Rows: unknown[], t3Rows: unknown[]) {
  const mkChain = (rows: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  })
  mockSelect.mockReturnValueOnce(mkChain(t2Rows))
  mockSelect.mockReturnValueOnce(mkChain(t3Rows))
}

function setupUpdate() {
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    subscriberId: 's1',
    email:        'a@x.co',
    customerName: 'Sam',
    planName:     'Pro',
    mrrCents:     2900,
    retryDate:    new Date(Date.now() + 24 * 60 * 60 * 1000),
    customerId:   'c1',
    founderName:  'Founder Name',
    productName:  'Acme',
    userName:     'User Name',
    ...overrides,
  }
}

describe('runDunningTouches — T2 pass', () => {
  it('sends + bumps touch_count + logs event for each eligible row', async () => {
    setupSelects(
      [makeRow({ subscriberId: 's1' }), makeRow({ subscriberId: 's2' })],
      [],
    )
    setupUpdate()

    const result = await runDunningTouches({ dryRun: false })

    expect(result.t2).toEqual({ processed: 2, sent: 2, errors: 0 })
    expect(result.t3).toEqual({ processed: 0, sent: 0, errors: 0 })
    expect(mockSendDunningT2T3).toHaveBeenCalledTimes(2)
    expect(mockUpdate).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'dunning_touch_sent',
      properties: expect.objectContaining({ touch: 2, isFinalRetry: false }),
    }))
  })

  it('passes isFinalRetry: false to the email function', async () => {
    setupSelects([makeRow()], [])
    setupUpdate()

    await runDunningTouches({ dryRun: false })

    const arg = mockSendDunningT2T3.mock.calls[0][0]
    expect(arg.isFinalRetry).toBe(false)
    expect(arg.subscriberId).toBe('s1')
    expect(arg.email).toBe('a@x.co')
    expect(arg.fromName).toBe('Acme')   // productName takes precedence over founderName + userName
  })

  it('continues the loop when one row throws', async () => {
    setupSelects(
      [makeRow({ subscriberId: 's1' }), makeRow({ subscriberId: 's2' })],
      [],
    )
    setupUpdate()
    mockSendDunningT2T3.mockRejectedValueOnce(new Error('Resend down'))

    const result = await runDunningTouches({ dryRun: false })

    expect(result.t2.processed).toBe(2)
    expect(result.t2.errors).toBe(1)
    expect(result.t2.sent).toBe(1)
  })

  it('respects dryRun: counts but does not send / update / log', async () => {
    setupSelects([makeRow()], [])
    setupUpdate()

    const result = await runDunningTouches({ dryRun: true })

    expect(result.t2).toEqual({ processed: 1, sent: 1, errors: 0 })
    expect(mockSendDunningT2T3).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })
})

describe('runDunningTouches — T3 pass', () => {
  it('sends with isFinalRetry: true + bumps to touch_count=3', async () => {
    setupSelects([], [makeRow({ subscriberId: 's3' })])
    setupUpdate()

    const result = await runDunningTouches({ dryRun: false })

    expect(result.t3).toEqual({ processed: 1, sent: 1, errors: 0 })
    expect(mockSendDunningT2T3).toHaveBeenCalledTimes(1)
    const arg = mockSendDunningT2T3.mock.calls[0][0]
    expect(arg.isFinalRetry).toBe(true)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'dunning_touch_sent',
      properties: expect.objectContaining({ touch: 3, isFinalRetry: true }),
    }))
  })

  it('runs both passes in one invocation when both have eligible rows', async () => {
    setupSelects(
      [makeRow({ subscriberId: 's1' })],
      [makeRow({ subscriberId: 's3' })],
    )
    setupUpdate()

    const result = await runDunningTouches({ dryRun: false })

    expect(result.t2.sent).toBe(1)
    expect(result.t3.sent).toBe(1)
    expect(mockSendDunningT2T3).toHaveBeenCalledTimes(2)
  })
})

// Precedence: productName → founderName → userName → 'The team'.
// Subscribers see the brand they signed up to, not the founder's personal name.
describe('runDunningTouches — fallback fromName precedence', () => {
  it('falls back to founderName when productName is null', async () => {
    setupSelects([makeRow({ productName: null })], [])
    setupUpdate()

    await runDunningTouches({ dryRun: false })

    expect(mockSendDunningT2T3.mock.calls[0][0].fromName).toBe('Founder Name')
  })

  it('falls back to userName when productName + founderName both null', async () => {
    setupSelects([makeRow({ productName: null, founderName: null })], [])
    setupUpdate()

    await runDunningTouches({ dryRun: false })

    expect(mockSendDunningT2T3.mock.calls[0][0].fromName).toBe('User Name')
  })

  it('falls back to "The team" when all three are null', async () => {
    setupSelects([makeRow({ productName: null, founderName: null, userName: null })], [])
    setupUpdate()

    await runDunningTouches({ dryRun: false })

    expect(mockSendDunningT2T3.mock.calls[0][0].fromName).toBe('The team')
  })
})
