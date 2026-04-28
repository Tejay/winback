/**
 * Spec 31 — Pilot token lifecycle tests.
 *
 * Mirrors the Spec 29 password-reset token tests. Validates that:
 *   - generate / hash are stable + correct shape
 *   - validatePilotToken returns the right reason in all 4 states
 *   - consumePilotToken is atomic (returns null on race)
 *   - issuePilotToken bakes a 14-day TTL into the row
 *   - countPilotSlotsUsed sums active pilots + pending tokens
 *   - isCustomerOnPilot + getPilotUntil read the column correctly
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
  customers: {
    id:                   'customers.id',
    pilotUntil:           'customers.pilot_until',
    pilotEndingWarnedAt:  'customers.pilot_ending_warned_at',
    userId:               'customers.user_id',
    founderName:          'customers.founder_name',
  },
  users:       { id: 'users.id', email: 'users.email', isAdmin: 'users.is_admin' },
  pilotTokens: {
    id:               'pt.id',
    tokenHash:        'pt.token_hash',
    expiresAt:        'pt.expires_at',
    usedAt:           'pt.used_at',
    usedByUserId:     'pt.used_by_user_id',
    note:             'pt.note',
    createdAt:        'pt.created_at',
    createdByUserId:  'pt.created_by_user_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq:        vi.fn((a, b) => ({ eq: [a, b] })),
  and:       vi.fn((...args) => ({ and: args })),
  gt:        vi.fn((a, b) => ({ gt: [a, b] })),
  isNull:    vi.fn((a) => ({ isNull: a })),
  isNotNull: vi.fn((a) => ({ isNotNull: a })),
  sql:       Object.assign(
    vi.fn((strs, ...vals) => ({ sql: { strs, vals } })),
    { raw: vi.fn() },
  ),
}))

vi.mock('../lib/email', () => ({
  sendPilotEndingSoonEmail: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../lib/events', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}))

import {
  generateRawToken,
  hashToken,
  validatePilotToken,
  consumePilotToken,
  issuePilotToken,
  isCustomerOnPilot,
  getPilotUntil,
  countPilotSlotsUsed,
  PILOT_TOKEN_TTL_DAYS,
} from '../lib/pilot'

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

function selectCount(rows: unknown[]) {
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

function insertReturning(rows: unknown[]) {
  const valuesFn = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue(rows),
  })
  mockInsert.mockReturnValueOnce({ values: valuesFn })
  return valuesFn
}

describe('hashToken', () => {
  it('is stable and 64-char hex', () => {
    expect(hashToken('a')).toBe(hashToken('a'))
    expect(hashToken('a')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken('a')).not.toBe(hashToken('b'))
  })
})

describe('generateRawToken', () => {
  it('produces unique url-safe tokens of >= 40 chars', () => {
    const a = generateRawToken()
    const b = generateRawToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(40)
  })
})

describe('validatePilotToken', () => {
  it('returns not-found for empty input without DB call', async () => {
    const res = await validatePilotToken('')
    expect(res).toEqual({ ok: false, reason: 'not-found' })
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('returns not-found when no row matches', async () => {
    selectReturning([])
    expect(await validatePilotToken('garbage')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('returns used when used_at is set', async () => {
    selectReturning([{
      id: 't1', usedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    }])
    expect(await validatePilotToken('raw')).toEqual({ ok: false, reason: 'used' })
  })

  it('returns expired when expires_at is past', async () => {
    selectReturning([{
      id: 't1', usedAt: null, expiresAt: new Date(Date.now() - 1000),
    }])
    expect(await validatePilotToken('raw')).toEqual({ ok: false, reason: 'expired' })
  })

  it('returns ok with tokenId for a fresh unused token', async () => {
    selectReturning([{
      id: 't1', usedAt: null, expiresAt: new Date(Date.now() + 60_000),
    }])
    expect(await validatePilotToken('raw')).toEqual({ ok: true, tokenId: 't1' })
  })
})

describe('consumePilotToken', () => {
  it('returns null on empty input without DB call', async () => {
    expect(await consumePilotToken('')).toBeNull()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('returns the tokenId when conditional UPDATE matches', async () => {
    updateReturning([{ id: 't1' }])
    expect(await consumePilotToken('raw')).toBe('t1')
  })

  it('returns null when the conditional UPDATE matches nothing', async () => {
    updateReturning([])
    expect(await consumePilotToken('raw')).toBeNull()
  })
})

describe('issuePilotToken', () => {
  it('inserts a row with sha256(raw) and a 14-day TTL', async () => {
    const valuesFn = insertReturning([{ id: 't1' }])
    const res = await issuePilotToken({ note: 'pilot-1', createdByUserId: 'u1' })
    expect(typeof res.rawToken).toBe('string')
    expect(res.tokenId).toBe('t1')
    const insertedRow = valuesFn.mock.calls[0][0] as {
      tokenHash: string
      expiresAt: Date
      note: string
      createdByUserId: string
    }
    expect(insertedRow.tokenHash).toBe(hashToken(res.rawToken))
    expect(insertedRow.note).toBe('pilot-1')
    expect(insertedRow.createdByUserId).toBe('u1')
    const ttlMs = PILOT_TOKEN_TTL_DAYS * 24 * 60 * 60_000
    const drift = Math.abs(insertedRow.expiresAt.getTime() - (Date.now() + ttlMs))
    expect(drift).toBeLessThan(5_000)
  })
})

describe('isCustomerOnPilot / getPilotUntil', () => {
  it('isCustomerOnPilot returns false on empty id without DB call', async () => {
    expect(await isCustomerOnPilot('')).toBe(false)
    expect(mockSelect).not.toHaveBeenCalled()
  })

  it('isCustomerOnPilot returns true when query finds a row', async () => {
    selectReturning([{ id: 'c1' }])
    expect(await isCustomerOnPilot('c1')).toBe(true)
  })

  it('isCustomerOnPilot returns false when no row', async () => {
    selectReturning([])
    expect(await isCustomerOnPilot('c1')).toBe(false)
  })

  it('getPilotUntil returns the stored timestamp', async () => {
    const ts = new Date(Date.now() + 30 * 24 * 60 * 60_000)
    selectReturning([{ pilotUntil: ts }])
    expect(await getPilotUntil('c1')).toEqual(ts)
  })

  it('getPilotUntil returns null when no row', async () => {
    selectReturning([])
    expect(await getPilotUntil('c1')).toBeNull()
  })
})

describe('countPilotSlotsUsed', () => {
  it('sums active pilots + pending tokens', async () => {
    selectCount([{ c: 4 }])  // active
    selectCount([{ c: 3 }])  // pending
    expect(await countPilotSlotsUsed()).toBe(7)
  })

  it('returns 0 when both are empty', async () => {
    selectCount([{ c: 0 }])
    selectCount([{ c: 0 }])
    expect(await countPilotSlotsUsed()).toBe(0)
  })
})
