/**
 * Spec 32 — Email-verification token lifecycle tests.
 *
 * Mirrors password-reset.test.ts. Validates:
 *   - hash / generate are stable + correct shape
 *   - validateVerificationToken returns the right reason for all 4 states
 *   - consumeVerificationToken is atomic
 *   - issueVerificationToken bakes a 7-day TTL into the row
 *   - markUserEmailVerified updates the user column
 *   - findUserForResend / recentVerificationTokenCount work
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
  users: {
    id:              'users.id',
    email:           'users.email',
    emailVerifiedAt: 'users.email_verified_at',
  },
  emailVerificationTokens: {
    id:        'evt.id',
    userId:    'evt.user_id',
    tokenHash: 'evt.token_hash',
    expiresAt: 'evt.expires_at',
    usedAt:    'evt.used_at',
    createdAt: 'evt.created_at',
    ipAddress: 'evt.ip_address',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq:     vi.fn((a, b) => ({ eq: [a, b] })),
  and:    vi.fn((...a) => ({ and: a })),
  gt:     vi.fn((a, b) => ({ gt: [a, b] })),
  isNull: vi.fn((a) => ({ isNull: a })),
}))

import {
  generateRawToken,
  hashToken,
  validateVerificationToken,
  consumeVerificationToken,
  issueVerificationToken,
  markUserEmailVerified,
  findUserForResend,
  recentVerificationTokenCount,
  VERIFY_TOKEN_TTL_DAYS,
} from '../lib/email-verification'

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

function selectAll(rows: unknown[]) {
  mockSelect.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
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
  mockUpdate.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
}

describe('hashToken / generateRawToken', () => {
  it('hash is stable and 64-char hex', () => {
    expect(hashToken('a')).toBe(hashToken('a'))
    expect(hashToken('a')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })

  it('raw token is unique url-safe and >= 40 chars', () => {
    const a = generateRawToken()
    const b = generateRawToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(40)
  })
})

describe('validateVerificationToken', () => {
  it('returns not-found for empty input without DB call', async () => {
    expect(await validateVerificationToken('')).toEqual({ ok: false, reason: 'not-found' })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('returns not-found when no row matches', async () => {
    selectReturning([])
    expect(await validateVerificationToken('garbage')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('returns used when row has used_at set', async () => {
    selectReturning([{
      id: 't1', userId: 'u1', usedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }])
    expect(await validateVerificationToken('raw')).toEqual({ ok: false, reason: 'used' })
  })

  it('returns expired when expires_at is past', async () => {
    selectReturning([{
      id: 't1', userId: 'u1', usedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    }])
    expect(await validateVerificationToken('raw')).toEqual({ ok: false, reason: 'expired' })
  })

  it('returns ok with userId+tokenId for fresh unused token', async () => {
    selectReturning([{
      id: 't1', userId: 'u1', usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }])
    expect(await validateVerificationToken('raw')).toEqual({
      ok: true, tokenId: 't1', userId: 'u1',
    })
  })
})

describe('consumeVerificationToken', () => {
  it('returns null on empty input without DB call', async () => {
    expect(await consumeVerificationToken('')).toBeNull()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns userId when conditional UPDATE matches', async () => {
    updateReturning([{ userId: 'u1' }])
    expect(await consumeVerificationToken('raw')).toBe('u1')
  })

  it('returns null when the conditional UPDATE matches nothing (used/expired/race)', async () => {
    updateReturning([])
    expect(await consumeVerificationToken('raw')).toBeNull()
  })
})

describe('issueVerificationToken', () => {
  it('invalidates prior unused tokens, then inserts a fresh one with 7-day TTL', async () => {
    updateNoReturn()
    const valuesFn = vi.fn().mockResolvedValue(undefined)
    mockInsert.mockReturnValueOnce({ values: valuesFn })

    const raw = await issueVerificationToken({ userId: 'u1', ipAddress: '1.2.3.4' })

    expect(typeof raw).toBe('string')
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockInsert).toHaveBeenCalledTimes(1)

    const insertedRow = valuesFn.mock.calls[0][0] as {
      userId: string
      tokenHash: string
      expiresAt: Date
      ipAddress: string | null
    }
    expect(insertedRow.userId).toBe('u1')
    expect(insertedRow.ipAddress).toBe('1.2.3.4')
    expect(insertedRow.tokenHash).toBe(hashToken(raw))
    const ttlMs = VERIFY_TOKEN_TTL_DAYS * 24 * 60 * 60_000
    const drift = Math.abs(insertedRow.expiresAt.getTime() - (Date.now() + ttlMs))
    expect(drift).toBeLessThan(5_000)
  })
})

describe('markUserEmailVerified', () => {
  it('issues a single update against wb_users with email_verified_at set', async () => {
    const setFn = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    })
    mockUpdate.mockReturnValueOnce({ set: setFn })

    await markUserEmailVerified('u1')

    expect(setFn).toHaveBeenCalledTimes(1)
    const arg = setFn.mock.calls[0][0]
    expect(arg.emailVerifiedAt).toBeInstanceOf(Date)
  })
})

describe('findUserForResend / recentVerificationTokenCount', () => {
  it('findUserForResend returns null when no row', async () => {
    selectReturning([])
    expect(await findUserForResend('ghost@example.com')).toBeNull()
  })

  it('findUserForResend returns the row when found', async () => {
    selectReturning([{ id: 'u1', emailVerifiedAt: null }])
    expect(await findUserForResend('a@x.co')).toEqual({ id: 'u1', emailVerifiedAt: null })
  })

  it('recentVerificationTokenCount counts rows in the window', async () => {
    selectAll([{ id: 't1' }, { id: 't2' }])
    expect(await recentVerificationTokenCount({ userId: 'u1', windowMs: 60_000 })).toBe(2)
  })

  it('recentVerificationTokenCount returns 0 when no rows', async () => {
    selectAll([])
    expect(await recentVerificationTokenCount({ userId: 'u1', windowMs: 60_000 })).toBe(0)
  })
})
