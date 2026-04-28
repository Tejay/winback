/**
 * Spec 31 — runPilotEndingWarnings cron-pass tests.
 *
 * Validates the daily Day-23 heads-up pass:
 *   - sends + writes pilot_ending_warned_at + logs event for each row
 *   - respects dryRun (no send, no update, no event)
 *   - continues the loop on per-row send failures
 *   - skips rows missing pilotUntil (defensive belt-and-braces)
 *
 * Eligibility (the BETWEEN clause + isAdmin filter etc) is a SQL
 * concern; this test mocks the bulk select directly with what would
 * have been returned, then asserts the per-row behaviour.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockSendPilotEndingSoon = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: {
    id: 'c.id', userId: 'c.uid', founderName: 'c.fname',
    pilotUntil: 'c.pu', pilotEndingWarnedAt: 'c.pewa',
  },
  users:       { id: 'u.id', email: 'u.email', isAdmin: 'u.is_admin' },
  pilotTokens: {},
}))

vi.mock('drizzle-orm', () => ({
  eq:        vi.fn((a, b) => ({ eq: [a, b] })),
  and:       vi.fn((...a) => ({ and: a })),
  gt:        vi.fn((a, b) => ({ gt: [a, b] })),
  isNull:    vi.fn((a) => ({ isNull: a })),
  isNotNull: vi.fn((a) => ({ isNotNull: a })),
  sql:       Object.assign(
    vi.fn((strs, ...vals) => ({ sql: { strs, vals } })),
    { raw: vi.fn() },
  ),
}))

vi.mock('../lib/email', () => ({
  sendPilotEndingSoonEmail: mockSendPilotEndingSoon,
}))

vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { runPilotEndingWarnings } from '../lib/pilot'

beforeEach(() => {
  vi.clearAllMocks()
  mockSendPilotEndingSoon.mockResolvedValue(undefined)
})

function setupBulkSelect(rows: unknown[]) {
  mockSelect.mockImplementationOnce(() => ({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  }))
}

function setupUpdate() {
  mockUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })
}

describe('runPilotEndingWarnings', () => {
  it('sends + updates + logs for each eligible row', async () => {
    const pu = new Date(Date.now() + 7 * 24 * 60 * 60_000)
    setupBulkSelect([
      { customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: 'A', pilotUntil: pu },
      { customerId: 'c2', userId: 'u2', email: 'b@x.co', founderName: null, pilotUntil: pu },
    ])
    setupUpdate()

    const result = await runPilotEndingWarnings({ dryRun: false })

    expect(result).toEqual({ processed: 2, sent: 2, errors: 0 })
    expect(mockSendPilotEndingSoon).toHaveBeenCalledTimes(2)
    expect(mockUpdate).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'pilot_ending_soon_sent',
      customerId: 'c1',
      properties: expect.objectContaining({ pilotUntil: pu.toISOString() }),
    }))
  })

  it('respects dryRun: counts but does not send/update/log', async () => {
    const pu = new Date(Date.now() + 7 * 24 * 60 * 60_000)
    setupBulkSelect([
      { customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null, pilotUntil: pu },
    ])

    const result = await runPilotEndingWarnings({ dryRun: true })

    expect(result).toEqual({ processed: 1, sent: 1, errors: 0 })
    expect(mockSendPilotEndingSoon).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('continues the loop when a send throws', async () => {
    const pu = new Date(Date.now() + 7 * 24 * 60 * 60_000)
    setupBulkSelect([
      { customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null, pilotUntil: pu },
      { customerId: 'c2', userId: 'u2', email: 'b@x.co', founderName: null, pilotUntil: pu },
    ])
    setupUpdate()
    mockSendPilotEndingSoon.mockRejectedValueOnce(new Error('Resend down'))

    const result = await runPilotEndingWarnings({ dryRun: false })

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(1)
    expect(result.sent).toBe(1)
  })

  it('skips a row whose pilotUntil somehow came back null', async () => {
    setupBulkSelect([
      { customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null, pilotUntil: null },
    ])

    const result = await runPilotEndingWarnings({ dryRun: false })

    expect(result.sent).toBe(0)
    expect(mockSendPilotEndingSoon).not.toHaveBeenCalled()
  })
})
