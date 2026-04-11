import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock googleapis
const mockSend = vi.hoisted(() => vi.fn())
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = vi.fn()
      },
    },
    gmail: () => ({
      users: {
        messages: {
          send: mockSend,
        },
      },
    }),
  },
}))

// Mock database
const mockInsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({
  db: {
    insert: mockInsert,
    update: mockUpdate,
  },
}))

vi.mock('@/lib/schema', () => ({
  emailsSent: 'wb_emails_sent',
  churnedSubscribers: 'wb_churned_subscribers',
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ a, b })),
}))

import { sendEmail, scheduleExitEmail } from '../lib/email'
import { ClassificationResult } from '../lib/types'

describe('sendEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSend.mockResolvedValue({
      data: { id: 'msg_123', threadId: 'thread_456' },
    })
  })

  it('sends RFC 2822 formatted email via Gmail API', async () => {
    const result = await sendEmail({
      refreshToken: 'test_refresh_token',
      to: 'sarah@example.com',
      subject: 'Test subject',
      body: 'Hello Sarah, this is a test.',
    })

    expect(mockSend).toHaveBeenCalledOnce()
    const callArgs = mockSend.mock.calls[0][0]

    // Decode the raw message
    const raw = callArgs.requestBody.raw
    const decoded = Buffer.from(raw, 'base64').toString('utf8')

    expect(decoded).toContain('To: sarah@example.com')
    expect(decoded).toContain('Subject: Test subject')
    expect(decoded).toContain('Hello Sarah, this is a test.')
    expect(decoded).toContain('Content-Type: text/plain; charset=utf-8')

    expect(result.messageId).toBe('msg_123')
    expect(result.threadId).toBe('thread_456')
  })

  it('uses base64url encoding (no +, /, or = chars)', async () => {
    await sendEmail({
      refreshToken: 'token',
      to: 'test@test.com',
      subject: 'Subject with special chars: café résumé',
      body: 'Body with special chars: naïve',
    })

    const raw = mockSend.mock.calls[0][0].requestBody.raw
    expect(raw).not.toMatch(/[+/=]/)
  })
})

describe('scheduleExitEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockSend.mockResolvedValue({
      data: { id: 'msg_exit', threadId: 'thread_exit' },
    })
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue([]) })
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })
  })

  it('calls sendEmail after the correct delay', async () => {
    const classification: ClassificationResult = {
      tier: 1,
      tierReason: 'test',
      cancellationReason: 'test reason',
      cancellationCategory: 'Feature',
      confidence: 0.9,
      suppress: false,
      firstMessage: {
        subject: 'Exit email subject',
        body: 'Exit email body',
        sendDelaySecs: 60,
      },
      triggerKeyword: null,
      fallbackDays: 90,
      winBackSubject: 'Win back subject',
      winBackBody: 'Win back body',
    }

    scheduleExitEmail({
      subscriberId: 'sub_123',
      email: 'test@example.com',
      classification,
      refreshToken: 'refresh_token',
    })

    // Should not have sent yet
    expect(mockSend).not.toHaveBeenCalled()

    // Advance timer past the delay
    await vi.advanceTimersByTimeAsync(61000)

    expect(mockSend).toHaveBeenCalledOnce()
    expect(mockInsert).toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()

    vi.useRealTimers()
  })
})
