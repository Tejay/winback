/**
 * Spec 32 — POST /api/auth/resend-verification
 *
 * Always-200 contract (no enumeration), mirrors Spec 29 forgot-password:
 *  - unknown email → no email sent
 *  - already-verified email → no email sent
 *  - rate-limit hit → no email sent
 *  - known unverified email → email sent + event logged
 *  - email-send failure → still returns 200, doesn't throw
 *  - invalid body → silent 200
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindUserForResend         = vi.hoisted(() => vi.fn())
const mockIssueVerificationToken    = vi.hoisted(() => vi.fn())
const mockRecentTokenCount          = vi.hoisted(() => vi.fn())
const mockSendVerificationEmail     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent                  = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/src/winback/lib/email-verification', () => ({
  findUserForResend:               mockFindUserForResend,
  issueVerificationToken:          mockIssueVerificationToken,
  recentVerificationTokenCount:    mockRecentTokenCount,
}))

vi.mock('@/src/winback/lib/email', () => ({
  sendVerificationEmail: mockSendVerificationEmail,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/auth/resend-verification/route'

beforeEach(() => {
  vi.clearAllMocks()
  mockRecentTokenCount.mockResolvedValue(0)
  mockIssueVerificationToken.mockResolvedValue('raw_xyz')
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
})

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/auth/resend-verification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/resend-verification', () => {
  it('unknown email → 200, no token issued, no email sent', async () => {
    mockFindUserForResend.mockResolvedValue(null)
    const res = await POST(makeReq({ email: 'ghost@example.com' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockIssueVerificationToken).not.toHaveBeenCalled()
    expect(mockSendVerificationEmail).not.toHaveBeenCalled()
  })

  it('already-verified email → 200, no email sent', async () => {
    mockFindUserForResend.mockResolvedValue({ id: 'u1', emailVerifiedAt: new Date() })
    const res = await POST(makeReq({ email: 'a@x.co' }))
    expect(res.status).toBe(200)
    expect(mockIssueVerificationToken).not.toHaveBeenCalled()
    expect(mockSendVerificationEmail).not.toHaveBeenCalled()
  })

  it('rate-limit hit → 200, no email sent', async () => {
    mockFindUserForResend.mockResolvedValue({ id: 'u1', emailVerifiedAt: null })
    mockRecentTokenCount.mockResolvedValueOnce(99)
    const res = await POST(makeReq({ email: 'a@x.co' }))
    expect(res.status).toBe(200)
    expect(mockIssueVerificationToken).not.toHaveBeenCalled()
    expect(mockSendVerificationEmail).not.toHaveBeenCalled()
  })

  it('known unverified email → 200, token issued + email sent + event logged', async () => {
    mockFindUserForResend.mockResolvedValue({ id: 'u1', emailVerifiedAt: null })
    const res = await POST(makeReq({ email: 'a@x.co' }))
    expect(res.status).toBe(200)
    expect(mockIssueVerificationToken).toHaveBeenCalledTimes(1)
    expect(mockSendVerificationEmail).toHaveBeenCalledTimes(1)
    const sendArg = mockSendVerificationEmail.mock.calls[0][0]
    expect(sendArg.to).toBe('a@x.co')
    expect(sendArg.verifyUrl).toContain('/verify-email?token=')
    expect(sendArg.verifyUrl).toContain('raw_xyz')
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'verification_email_resent',
      userId: 'u1',
    }))
  })

  it('lowercases the email before lookup', async () => {
    mockFindUserForResend.mockResolvedValue({ id: 'u1', emailVerifiedAt: null })
    await POST(makeReq({ email: 'Mixed@Case.COM' }))
    expect(mockFindUserForResend).toHaveBeenCalledWith('mixed@case.com')
  })

  it('swallows email-send failure (still returns 200)', async () => {
    mockFindUserForResend.mockResolvedValue({ id: 'u1', emailVerifiedAt: null })
    mockSendVerificationEmail.mockRejectedValueOnce(new Error('Resend down'))
    const res = await POST(makeReq({ email: 'a@x.co' }))
    expect(res.status).toBe(200)
  })

  it('invalid body → 200 silently (no enumeration)', async () => {
    const res = await POST(makeReq({ email: 'not-an-email' }))
    expect(res.status).toBe(200)
    expect(mockFindUserForResend).not.toHaveBeenCalled()
  })
})
