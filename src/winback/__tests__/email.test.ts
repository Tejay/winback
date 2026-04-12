import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Resend
const mockSend = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend }
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
      data: { id: 'msg_123' },
      error: null,
    })
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
    expect(callArgs.from).toContain('reply+sub_abc123@winbackflow.co')
    expect(result.messageId).toBe('msg_123')
  })

  it('throws on Resend error', async () => {
    mockSend.mockResolvedValue({
      data: null,
      error: { message: 'Invalid recipient' },
    })

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
    vi.clearAllMocks()
    mockSend.mockResolvedValue({
      data: { id: 'msg_exit' },
      error: null,
    })
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue([]) })
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    })
  })

  it('sends email immediately and updates database', async () => {
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
    const classification: ClassificationResult = {
      tier: 4,
      tierReason: 'suppress',
      cancellationReason: 'test account',
      cancellationCategory: 'Other',
      confidence: 0.95,
      suppress: true,
      firstMessage: null,
      triggerKeyword: null,
      fallbackDays: 90,
      winBackSubject: '',
      winBackBody: '',
    }

    await scheduleExitEmail({
      subscriberId: 'sub_456',
      email: 'test@example.com',
      classification,
      fromName: 'Alex',
    })

    expect(mockSend).not.toHaveBeenCalled()
  })
})
