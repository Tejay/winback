/**
 * Spec 25 — requireAdmin() tests.
 *
 * Verifies the three auth states:
 *   - no session       → { error: 'Not signed in', status: 401 }
 *   - session, !admin  → { error: 'Admin only', status: 403 }
 *   - session, admin   → { userId }
 *
 * Also verifies the fallback to `db` when `dbReadOnly` throws (the env-not-set
 * case during rollout).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuth = vi.hoisted(() => vi.fn())
const mockReadOnlySelect = vi.hoisted(() => vi.fn())
const mockReadWriteSelect = vi.hoisted(() => vi.fn())
const mockGetDbReadOnly = vi.hoisted(() =>
  vi.fn(() => ({ select: mockReadOnlySelect })),
)

vi.mock('next-auth', () => ({
  default: () => ({ handlers: {}, auth: mockAuth, signIn: vi.fn(), signOut: vi.fn() }),
}))

vi.mock('next-auth/providers/credentials', () => ({
  default: () => ({}),
}))

vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}))

vi.mock('@/lib/db', () => ({
  db:            { select: mockReadWriteSelect },
  getDbReadOnly: mockGetDbReadOnly,
}))

vi.mock('@/lib/schema', () => ({
  users: { id: 'users_id', isAdmin: 'is_admin' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

import { requireAdmin } from '../../../lib/auth'

beforeEach(() => {
  vi.clearAllMocks()
})

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

describe('requireAdmin', () => {
  it('returns 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null)
    const result = await requireAdmin()
    expect(result).toEqual({ error: 'Not signed in', status: 401 })
  })

  it('returns 403 when signed in but not admin', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_123' } })
    mockReadOnlySelect.mockReturnValue(selectChain([{ isAdmin: false }]))
    const result = await requireAdmin()
    expect(result).toEqual({ error: 'Admin only', status: 403 })
  })

  it('returns userId when signed in as admin', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_admin' } })
    mockReadOnlySelect.mockReturnValue(selectChain([{ isAdmin: true }]))
    const result = await requireAdmin()
    expect(result).toEqual({ userId: 'user_admin' })
  })

  it('falls back to db when dbReadOnly throws (env not yet provisioned)', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_admin' } })
    mockGetDbReadOnly.mockImplementationOnce(() => {
      throw new Error('DATABASE_URL_READONLY is not set')
    })
    mockReadWriteSelect.mockReturnValue(selectChain([{ isAdmin: true }]))
    const result = await requireAdmin()
    expect(result).toEqual({ userId: 'user_admin' })
    expect(mockReadWriteSelect).toHaveBeenCalled()
  })

  it('returns 403 from fallback path when admin row is missing', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_x' } })
    mockGetDbReadOnly.mockImplementationOnce(() => {
      throw new Error('DATABASE_URL_READONLY is not set')
    })
    mockReadWriteSelect.mockReturnValue(selectChain([]))
    const result = await requireAdmin()
    expect(result).toEqual({ error: 'Admin only', status: 403 })
  })
})
