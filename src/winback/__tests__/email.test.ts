import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Resend
const mockSend = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend }
  },
}))

// Mock database — select/insert/update
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
  churnedSubscribers: { doNotContact: 'do_not_contact', id: 'id', customerId: 'customer_id' },
  customers: { id: 'customer_id_col', pausedAt: 'paused_at' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ a, b })),
}))

import { sendEmail, scheduleExitEmail, recordEmailSentIdempotent } from '../lib/email'
import { ClassificationResult } from '../lib/types'

/**
 * scheduleExitEmail issues two db.select() calls:
 *   1. isDoNotContact → select().from().where().limit() → [{ dnc }]
 *   2. isCustomerPausedForSubscriber → select().from().innerJoin().where().limit() → [{ pausedAt }]
 * sendEmail issues just the first (DNC) call.
 * This helper configures both in order.
 */
function mockDbGates({ dnc = false, pausedAt = null }: { dnc?: boolean; pausedAt?: Date | null } = {}) {
  // scheduleExitEmail can call isDoNotContact twice (once directly, once inside sendEmail)
  // and isCustomerPausedForSubscriber once. Match chain shape by presence of innerJoin.
  mockSelect.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      // DNC chain: no innerJoin
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ dnc }]),
      }),
      // Paused chain: innerJoin → where → limit
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ pausedAt }]),
        }),
      }),
    }),
  }))
}

function mockDncReturns(dnc: boolean) {
  mockDbGates({ dnc })
}

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-hmac-signing'
  process.env.NEXT_PUBLIC_APP_URL = 'https://winbackflow.co'
})

describe('sendEmail', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockSend.mockResolvedValue({ data: { id: 'msg_123' }, error: null })
    mockDncReturns(false)
  })

  it('sends email via Resend with correct from address', async () => {
    const result = await sendEmail({
      to: 'sarah@example.com',
      subject: 'Test subject',
      body: 'Hello Sarah, this is a test.',
      fromName: 'Alex from Acme',
      subscriberId: 'sub_abc123',
    })

    expect(mockSend).toHaveBeenCalledOnce()
    const callArgs = mockSend.mock.calls[0][0]

    expect(callArgs.to).toBe('sarah@example.com')
    expect(callArgs.subject).toBe('Test subject')
    expect(callArgs.text).toContain('Hello Sarah, this is a test.')
    expect(callArgs.text).toContain('/api/reactivate/sub_abc123')
    expect(callArgs.from).toContain('Alex from Acme')
    expect(callArgs.from).toContain('reply+sub_abc123@reply.winbackflow.co')
    expect(result.messageId).toBe('msg_123')
  })

  it('includes unsubscribe link in the email body', async () => {
    await sendEmail({
      to: 'sarah@example.com',
      subject: 'Test',
      body: 'Body',
      fromName: 'Alex',
      subscriberId: 'sub_abc123',
    })
    const callArgs = mockSend.mock.calls[0][0]
    expect(callArgs.text).toContain('/api/unsubscribe/sub_abc123')
    expect(callArgs.text).toContain('unsubscribe')
  })

  it('sets List-Unsubscribe + List-Unsubscribe-Post headers', async () => {
    await sendEmail({
      to: 'sarah@example.com',
      subject: 'Test',
      body: 'Body',
      fromName: 'Alex',
      subscriberId: 'sub_abc123',
    })
    const callArgs = mockSend.mock.calls[0][0]
    expect(callArgs.headers['List-Unsubscribe']).toContain('/api/unsubscribe/sub_abc123')
    expect(callArgs.headers['List-Unsubscribe']).toContain('mailto:unsubscribe@winbackflow.co')
    expect(callArgs.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('skips send when subscriber has do_not_contact', async () => {
    mockDncReturns(true)
    const result = await sendEmail({
      to: 'sarah@example.com',
      subject: 'Test',
      body: 'Body',
      fromName: 'Alex',
      subscriberId: 'sub_abc123',
    })
    expect(mockSend).not.toHaveBeenCalled()
    expect(result.messageId).toBe('')
  })

  it('throws on Resend error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'Invalid recipient' } })
    await expect(sendEmail({
      to: 'bad@example.com',
      subject: 'Test',
      body: 'Test',
      fromName: 'Alex',
      subscriberId: 'sub_1',
    })).rejects.toThrow('Resend error: Invalid recipient')
  })
})

describe('scheduleExitEmail', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockSend.mockResolvedValue({ data: { id: 'msg_exit' }, error: null })
    mockDncReturns(false)
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue([]) })
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })
  })

  const classification: ClassificationResult = {
    tier: 1,
    tierReason: 'test',
    cancellationReason: 'test reason',
    cancellationCategory: 'Feature',
    confidence: 0.9,
    suppress: false,
    firstMessage: { subject: 'S', body: 'B', sendDelaySecs: 60 },
    triggerKeyword: null,
    triggerNeed: null,
    winBackSubject: 'W',
    winBackBody: 'B',
    handoff: false,
    handoffReasoning: '',
    recoveryLikelihood: 'low',
  }

  it('sends email immediately and updates database', async () => {
    await scheduleExitEmail({
      subscriberId: 'sub_123',
      email: 'test@example.com',
      classification,
      fromName: 'Alex from Acme',
    })

    expect(mockSend).toHaveBeenCalledOnce()
    expect(mockInsert).toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('skips email when firstMessage is null (suppressed)', async () => {
    const suppressed = { ...classification, firstMessage: null, suppress: true, tier: 4 as const }
    await scheduleExitEmail({
      subscriberId: 'sub_456',
      email: 'test@example.com',
      classification: suppressed,
      fromName: 'Alex',
    })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('skips email when subscriber has do_not_contact', async () => {
    mockDncReturns(true)
    await scheduleExitEmail({
      subscriberId: 'sub_789',
      email: 'test@example.com',
      classification,
      fromName: 'Alex',
    })
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('skips email when the customer has paused sending', async () => {
    mockDbGates({ dnc: false, pausedAt: new Date('2026-04-01') })
    await scheduleExitEmail({
      subscriberId: 'sub_paused',
      email: 'test@example.com',
      classification,
      fromName: 'Alex',
    })
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('sends email when the customer is not paused', async () => {
    mockDbGates({ dnc: false, pausedAt: null })
    await scheduleExitEmail({
      subscriberId: 'sub_live',
      email: 'test@example.com',
      classification,
      fromName: 'Alex',
    })
    expect(mockSend).toHaveBeenCalledOnce()
  })
})

// Spec 28 — idempotency at the wb_emails_sent layer.
describe('recordEmailSentIdempotent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('treats Postgres unique-violation (23505) as already-sent success', async () => {
    const violation = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    })
    mockInsert.mockReturnValue({
      values: vi.fn().mockRejectedValue(violation),
    })

    await expect(
      recordEmailSentIdempotent(
        { subscriberId: 'sub_x', type: 'exit', subject: 'hi' },
        'test',
      ),
    ).resolves.toBeUndefined()
  })

  it('rethrows non-unique-violation errors', async () => {
    const other = Object.assign(new Error('connection refused'), { code: '08006' })
    mockInsert.mockReturnValue({
      values: vi.fn().mockRejectedValue(other),
    })

    await expect(
      recordEmailSentIdempotent(
        { subscriberId: 'sub_x', type: 'exit', subject: 'hi' },
        'test',
      ),
    ).rejects.toBe(other)
  })

  it('happy path resolves when insert succeeds', async () => {
    mockInsert.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    })

    await expect(
      recordEmailSentIdempotent(
        { subscriberId: 'sub_x', type: 'exit', subject: 'hi' },
        'test',
      ),
    ).resolves.toBeUndefined()
  })
})
