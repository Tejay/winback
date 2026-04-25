/**
 * Spec 25 — lib/dsr.ts unit tests.
 * Mocks the db calls and verifies the export/delete shape contracts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockDelete = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelect,
    delete: mockDelete,
  },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: { id: 'sub_id', email: 'sub_email', subscriberId: 'sub_id' },
  emailsSent:         { id: 'email_id', subscriberId: 'sub_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq:        vi.fn((a, b) => ({ eq: [a, b] })),
  inArray:   vi.fn((a, b) => ({ inArray: [a, b] })),
}))

import { exportByEmail, deleteByEmail, deleteBySubscriberId } from '../../../lib/dsr'

beforeEach(() => {
  vi.clearAllMocks()
})

function selectReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  }
}

function selectReturningWithLimit(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

function deleteReturning() {
  return {
    where: vi.fn().mockResolvedValue([]),
  }
}

describe('exportByEmail', () => {
  it('returns found:false with empty arrays when no subscribers match', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([]))
    const result = await exportByEmail('nobody@example.com')
    expect(result).toEqual({
      email: 'nobody@example.com',
      found: false,
      subscribers: [],
      emails: [],
    })
  })

  it('returns subscribers + their emails when matches exist', async () => {
    const subs = [{ id: 'sub_1' }, { id: 'sub_2' }]
    const emails = [{ id: 'email_1' }, { id: 'email_2' }]
    mockSelect
      .mockReturnValueOnce(selectReturning(subs))
      .mockReturnValueOnce(selectReturning(emails))

    const result = await exportByEmail('pat@example.com')
    expect(result.found).toBe(true)
    expect(result.subscribers).toHaveLength(2)
    expect(result.emails).toHaveLength(2)
  })
})

describe('deleteByEmail', () => {
  it('returns zero counts and skips delete when no subscribers match', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([]))
    const result = await deleteByEmail('nobody@example.com')
    expect(result.deletedSubscribers).toBe(0)
    expect(result.deletedEmails).toBe(0)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes emails first then subscribers, returning counts', async () => {
    const subs = [{ id: 'sub_1' }, { id: 'sub_2' }]
    const emails = [{ id: 'email_a' }, { id: 'email_b' }, { id: 'email_c' }]
    mockSelect
      .mockReturnValueOnce(selectReturning(subs))
      .mockReturnValueOnce(selectReturning(emails))
    mockDelete.mockReturnValue(deleteReturning())

    const result = await deleteByEmail('pat@example.com')
    expect(result).toEqual({
      email: 'pat@example.com',
      deletedSubscribers: 2,
      deletedEmails: 3,
    })
    expect(mockDelete).toHaveBeenCalledTimes(2) // emails first, then subscribers
  })
})

describe('deleteBySubscriberId', () => {
  it('returns zero counts when subscriber not found', async () => {
    mockSelect.mockReturnValueOnce(selectReturningWithLimit([]))
    const result = await deleteBySubscriberId('sub_missing')
    expect(result.deletedSubscribers).toBe(0)
    expect(result.deletedEmails).toBe(0)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes one subscriber and its emails', async () => {
    mockSelect
      .mockReturnValueOnce(selectReturningWithLimit([{ id: 'sub_1', email: 'pat@example.com' }]))
      .mockReturnValueOnce(selectReturning([{ id: 'email_1' }, { id: 'email_2' }]))
    mockDelete.mockReturnValue(deleteReturning())

    const result = await deleteBySubscriberId('sub_1')
    expect(result).toEqual({
      email: 'pat@example.com',
      deletedSubscribers: 1,
      deletedEmails: 2,
    })
    expect(mockDelete).toHaveBeenCalledTimes(2)
  })
})
