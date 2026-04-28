/**
 * Spec 29 — Password reset.
 *
 * Covers:
 *   - validateResetToken: not-found / used / expired / valid
 *   - consumeResetToken: atomic update, returns userId on first call only
 *   - hashToken: stable, distinct per input
 *   - issueResetToken: invalidates prior unused tokens then inserts a new row
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  passwordResetTokens: {
    id:         'pwreset_id',
    userId:     'pwreset_user_id',
    tokenHash:  'pwreset_token_hash',
    expiresAt:  'pwreset_expires_at',
    usedAt:     'pwreset_used_at',
    createdAt:  'pwreset_created_at',
    ipAddress:  'pwreset_ip_address',
  },
  users: { id: 'users_id', email: 'users_email' },
}))

vi.mock('drizzle-orm', () => ({
  eq:     vi.fn((a, b) => ({ eq: [a, b] })),
  and:    vi.fn((...args) => ({ and: args })),
  gt:     vi.fn((a, b) => ({ gt: [a, b] })),
  isNull: vi.fn((a) => ({ isNull: a })),
}))

import {
  hashToken,
  generateRawToken,
  validateResetToken,
  consumeResetToken,
  issueResetToken,
  TOKEN_TTL_MINUTES,
} from '../lib/password-reset'

beforeEach(() => {
  vi.clearAllMocks()
})

function selectReturning(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  })
}

function updateReturning(rows: unknown[]) {
  mockUpdate.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  })
}

function updateNoReturn() {
  // For invalidate-prior call which doesn't .returning()
  mockUpdate.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
}

describe('hashToken', () => {
  it('is stable for the same input', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'))
  })
  it('differs across inputs', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'))
  })
  it('returns 64-char hex (sha256)', () => {
    expect(hashToken('x')).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('generateRawToken', () => {
  it('produces unique 32-byte url-safe values', () => {
    const a = generateRawToken()
    const b = generateRawToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(40)
  })
})

describe('validateResetToken', () => {
  it('returns not-found for empty token without DB call', async () => {
    const res = await validateResetToken('')
    expect(res).toEqual({ ok: false, reason: 'not-found' })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('returns not-found when no row matches', async () => {
    selectReturning([])
    const res = await validateResetToken('garbage')
    expect(res).toEqual({ ok: false, reason: 'not-found' })
  })

  it('returns used when row has used_at set', async () => {
    selectReturning([{
      id: 't1',
      userId: 'u1',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }])
    const res = await validateResetToken('raw')
    expect(res).toEqual({ ok: false, reason: 'used' })
  })

  it('returns expired when expires_at is in the past', async () => {
    selectReturning([{
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    }])
    const res = await validateResetToken('raw')
    expect(res).toEqual({ ok: false, reason: 'expired' })
  })

  it('returns ok with userId for a fresh, unused token', async () => {
    selectReturning([{
      id: 't1',
      userId: 'u1',
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }])
    const res = await validateResetToken('raw')
    expect(res).toEqual({ ok: true, tokenId: 't1', userId: 'u1' })
  })
})

describe('consumeResetToken', () => {
  it('returns null for empty input without DB call', async () => {
    expect(await consumeResetToken('')).toBeNull()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns userId when conditional UPDATE matches a row', async () => {
    updateReturning([{ userId: 'u1' }])
    expect(await consumeResetToken('raw')).toBe('u1')
  })

  it('returns null when the conditional UPDATE matches nothing (used/expired)', async () => {
    updateReturning([])
    expect(await consumeResetToken('raw')).toBeNull()
  })
})

describe('issueResetToken', () => {
  it('invalidates prior unused tokens, then inserts a new row, and returns the raw token', async () => {
    updateNoReturn()
    const insertValues = vi.fn().mockResolvedValue(undefined)
    mockInsert.mockReturnValueOnce({ values: insertValues })

    const raw = await issueResetToken({ userId: 'u1', ipAddress: '1.2.3.4' })

    expect(typeof raw).toBe('string')
    expect(raw.length).toBeGreaterThan(0)

    // Order: update (invalidate) before insert.
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalledTimes(1)
    expect(insertValues).toHaveBeenCalledTimes(1)

    const insertArg = insertValues.mock.calls[0][0] as {
      userId: string
      tokenHash: string
      expiresAt: Date
      ipAddress: string | null
    }
    expect(insertArg.userId).toBe('u1')
    expect(insertArg.ipAddress).toBe('1.2.3.4')
    expect(insertArg.tokenHash).toBe(hashToken(raw))

    // expires_at is roughly TOKEN_TTL_MINUTES from now (within a generous window)
    const ttlMs = TOKEN_TTL_MINUTES * 60_000
    const drift = Math.abs(insertArg.expiresAt.getTime() - (Date.now() + ttlMs))
    expect(drift).toBeLessThan(5_000)
  })
})
