/**
 * Spec 30 — Day-3 nudge + Day-83 deletion-warning email tests.
 *
 * Both functions sit in src/winback/lib/email.ts alongside the existing
 * `sendPasswordResetEmail`. They:
 *   - Use the Resend client via getResendClient() (which throws if
 *     RESEND_API_KEY is unset)
 *   - Wrap the send in callWithRetry
 *   - Throw on Resend error (caller handles per-row continue)
 *   - Have no DNC/AI-pause/footer machinery (transactional)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSend = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend }
  },
}))

vi.mock('@/lib/db', () => ({
  db: {},
}))

vi.mock('@/lib/schema', () => ({
  emailsSent: 'wb_emails_sent',
  churnedSubscribers: {},
  customers: {},
  users: {},
}))

vi.mock('drizzle-orm', () => ({
  eq:  vi.fn(),
  and: vi.fn(),
  count: vi.fn(),
}))

import {
  sendOnboardingNudgeEmail,
  sendDormantAccountDeletionWarningEmail,
} from '../lib/email'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.RESEND_API_KEY = 'test_key'
  process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'
  mockSend.mockResolvedValue({ data: { id: 'msg_1' }, error: null })
})

describe('sendOnboardingNudgeEmail', () => {
  it('sends with the right subject and onboarding URL', async () => {
    await sendOnboardingNudgeEmail({ to: 'f@x.co', founderName: 'Sam' })
    expect(mockSend).toHaveBeenCalledTimes(1)
    const arg = mockSend.mock.calls[0][0]
    expect(arg.to).toBe('f@x.co')
    expect(arg.subject).toContain('set up Winback')
    expect(arg.text).toContain('https://example.com/onboarding/stripe')
    expect(arg.text).toContain('Hi Sam,')
  })

  it('falls back to "Hi there" when founderName is null', async () => {
    await sendOnboardingNudgeEmail({ to: 'f@x.co', founderName: null })
    expect(mockSend.mock.calls[0][0].text).toContain('Hi there,')
  })

  it('throws when Resend returns an error', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { message: 'rate limited' } })
    await expect(
      sendOnboardingNudgeEmail({ to: 'f@x.co', founderName: null }),
    ).rejects.toThrow(/rate limited/)
  })

  it('throws when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY
    await expect(
      sendOnboardingNudgeEmail({ to: 'f@x.co', founderName: null }),
    ).rejects.toThrow(/RESEND_API_KEY/)
  })
})

describe('sendDormantAccountDeletionWarningEmail', () => {
  it('sends with the deletion-warning subject and the same onboarding URL', async () => {
    await sendDormantAccountDeletionWarningEmail({ to: 'f@x.co', founderName: 'Sam' })
    expect(mockSend).toHaveBeenCalledTimes(1)
    const arg = mockSend.mock.calls[0][0]
    expect(arg.subject).toContain('deleted in 7 days')
    expect(arg.text).toContain('https://example.com/onboarding/stripe')
    expect(arg.text).toContain('Hi Sam,')
  })

  it('falls back to "Hi there" when founderName is null', async () => {
    await sendDormantAccountDeletionWarningEmail({ to: 'f@x.co', founderName: null })
    expect(mockSend.mock.calls[0][0].text).toContain('Hi there,')
  })

  it('throws when Resend returns an error', async () => {
    mockSend.mockResolvedValueOnce({ data: null, error: { message: 'oops' } })
    await expect(
      sendDormantAccountDeletionWarningEmail({ to: 'f@x.co', founderName: null }),
    ).rejects.toThrow(/oops/)
  })

  it('throws when RESEND_API_KEY is unset', async () => {
    delete process.env.RESEND_API_KEY
    await expect(
      sendDormantAccountDeletionWarningEmail({ to: 'f@x.co', founderName: null }),
    ).rejects.toThrow(/RESEND_API_KEY/)
  })
})
