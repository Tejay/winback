/**
 * Spec 29 — POST /api/auth/forgot-password and /api/auth/reset-password.
 *
 * Verifies:
 *   - forgot: unknown email → 200, no token issued, no email sent
 *   - forgot: known email → 200, one token issued, one email sent
 *   - forgot: rate-limit hit → 200, no token, no email
 *   - forgot: invalid body → 200 (silent — no enumeration)
 *   - reset: invalid token → 410, no password update, invalid event
 *   - reset: valid token → 200, password_hash updated, completed event
 *   - reset: weak password → 400 before any DB work
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindUserIdByEmail = vi.hoisted(() => vi.fn())
const mockIssueResetToken    = vi.hoisted(() => vi.fn())
const mockRecentTokenCount   = vi.hoisted(() => vi.fn())
const mockConsumeResetToken  = vi.hoisted(() => vi.fn())
const mockSendPasswordReset  = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent           = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockBcryptHash         = vi.hoisted(() => vi.fn().mockResolvedValue('hashed_pw'))
const mockDbUpdate           = vi.hoisted(() => vi.fn())

vi.mock('@/src/winback/lib/password-reset', () => ({
  findUserIdByEmail: mockFindUserIdByEmail,
  issueResetToken:   mockIssueResetToken,
  recentTokenCount:  mockRecentTokenCount,
  consumeResetToken: mockConsumeResetToken,
}))

vi.mock('@/src/winback/lib/email', () => ({
  sendPasswordResetEmail: mockSendPasswordReset,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

vi.mock('bcryptjs', () => ({
  default: { hash: mockBcryptHash },
}))

vi.mock('@/lib/db', () => ({
  db: { update: mockDbUpdate },
}))

vi.mock('@/lib/schema', () => ({
  users: { id: 'users_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

import { POST as forgotPOST } from '../../../app/api/auth/forgot-password/route'
import { POST as resetPOST  } from '../../../app/api/auth/reset-password/route'

beforeEach(() => {
  vi.clearAllMocks()
  mockRecentTokenCount.mockResolvedValue(0)
  mockIssueResetToken.mockResolvedValue('raw_token_xyz')
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
})

function makeReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/forgot-password', () => {
  it('unknown email → 200, no token issued, no email sent', async () => {
    mockFindUserIdByEmail.mockResolvedValue(null)
    const res = await forgotPOST(makeReq(
      'http://localhost/api/auth/forgot-password',
      { email: 'ghost@example.com' },
    ))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(mockIssueResetToken).not.toHaveBeenCalled()
    expect(mockSendPasswordReset).not.toHaveBeenCalled()
  })

  it('known email → 200, one token, one email', async () => {
    mockFindUserIdByEmail.mockResolvedValue('u1')
    const res = await forgotPOST(makeReq(
      'http://localhost/api/auth/forgot-password',
      { email: 'real@example.com' },
    ))
    expect(res.status).toBe(200)
    expect(mockIssueResetToken).toHaveBeenCalledTimes(1)
    expect(mockSendPasswordReset).toHaveBeenCalledTimes(1)
    const sendArg = mockSendPasswordReset.mock.calls[0][0]
    expect(sendArg.to).toBe('real@example.com')
    expect(sendArg.resetUrl).toContain('/reset-password?token=')
    expect(sendArg.resetUrl).toContain('raw_token_xyz')
  })

  it('rate-limit hit → 200, no token, no email', async () => {
    mockFindUserIdByEmail.mockResolvedValue('u1')
    mockRecentTokenCount.mockResolvedValue(99)
    const res = await forgotPOST(makeReq(
      'http://localhost/api/auth/forgot-password',
      { email: 'real@example.com' },
    ))
    expect(res.status).toBe(200)
    expect(mockIssueResetToken).not.toHaveBeenCalled()
    expect(mockSendPasswordReset).not.toHaveBeenCalled()
  })

  it('invalid body → 200, silent (no enumeration)', async () => {
    const res = await forgotPOST(makeReq(
      'http://localhost/api/auth/forgot-password',
      { email: 'not-an-email' },
    ))
    expect(res.status).toBe(200)
    expect(mockFindUserIdByEmail).not.toHaveBeenCalled()
  })

  it('lowercases the email before lookup', async () => {
    mockFindUserIdByEmail.mockResolvedValue('u1')
    await forgotPOST(makeReq(
      'http://localhost/api/auth/forgot-password',
      { email: 'Mixed@Case.COM' },
    ))
    expect(mockFindUserIdByEmail).toHaveBeenCalledWith('mixed@case.com')
  })

  it('swallows email-send failure (returns 200)', async () => {
    mockFindUserIdByEmail.mockResolvedValue('u1')
    mockSendPasswordReset.mockRejectedValueOnce(new Error('Resend down'))
    const res = await forgotPOST(makeReq(
      'http://localhost/api/auth/forgot-password',
      { email: 'real@example.com' },
    ))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/auth/reset-password', () => {
  it('weak password → 400, no DB writes', async () => {
    const res = await resetPOST(makeReq(
      'http://localhost/api/auth/reset-password',
      { token: 'raw', password: 'short' },
    ))
    expect(res.status).toBe(400)
    expect(mockConsumeResetToken).not.toHaveBeenCalled()
    expect(mockDbUpdate).not.toHaveBeenCalled()
  })

  it('invalid/used/expired token → 410, no password update, invalid event', async () => {
    mockConsumeResetToken.mockResolvedValue(null)
    const res = await resetPOST(makeReq(
      'http://localhost/api/auth/reset-password',
      { token: 'raw', password: 'longenough' },
    ))
    expect(res.status).toBe(410)
    expect(mockDbUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'password_reset_invalid' }),
    )
  })

  it('valid token → 200, hashes password, updates user, emits completed event', async () => {
    mockConsumeResetToken.mockResolvedValue('u1')
    const res = await resetPOST(makeReq(
      'http://localhost/api/auth/reset-password',
      { token: 'raw', password: 'longenough' },
    ))
    expect(res.status).toBe(200)
    expect(mockBcryptHash).toHaveBeenCalledWith('longenough', 12)
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'password_reset_completed',
        userId: 'u1',
      }),
    )
  })

  it('replay of consumed token → 410 on second call', async () => {
    mockConsumeResetToken.mockResolvedValueOnce('u1').mockResolvedValueOnce(null)

    const ok = await resetPOST(makeReq(
      'http://localhost/api/auth/reset-password',
      { token: 'raw', password: 'longenough' },
    ))
    expect(ok.status).toBe(200)

    const replay = await resetPOST(makeReq(
      'http://localhost/api/auth/reset-password',
      { token: 'raw', password: 'longenough' },
    ))
    expect(replay.status).toBe(410)
  })
})
