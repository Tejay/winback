/**
 * Spec 30 — Onboarding follow-up cron helpers.
 *
 * Tests the three pure helpers in `src/winback/lib/onboarding-followup.ts`
 * by mocking @/lib/db, the email senders, and logEvent. The cron route
 * itself is just a thin wrapper around these — covered by smoke / manual
 * click-through, not unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect      = vi.hoisted(() => vi.fn())
const mockUpdate      = vi.hoisted(() => vi.fn())
const mockDelete      = vi.hoisted(() => vi.fn())
const mockSendNudge   = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockSendWarning = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockLogEvent    = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    delete: mockDelete,
  },
}))

vi.mock('@/lib/schema', () => ({
  customers: {
    id:                       'customers.id',
    userId:                   'customers.user_id',
    stripeAccountId:          'customers.stripe_account_id',
    onboardingNudgeSentAt:    'customers.onboarding_nudge_sent_at',
    deletionWarningSentAt:    'customers.deletion_warning_sent_at',
    founderName:              'customers.founder_name',
    createdAt:                'customers.created_at',
  },
  users: { id: 'users.id', email: 'users.email', isAdmin: 'users.is_admin' },
  recoveries: { customerId: 'recoveries.customer_id' },
}))

vi.mock('drizzle-orm', () => ({
  and:    vi.fn((...a) => ({ and: a })),
  eq:     vi.fn((a, b) => ({ eq: [a, b] })),
  isNull: vi.fn((a) => ({ isNull: a })),
  sql:    Object.assign(
    vi.fn((strs, ...vals) => ({ sql: { strs, vals } })),
    { raw: vi.fn() },
  ),
}))

vi.mock('../lib/email', () => ({
  sendOnboardingNudgeEmail:                 mockSendNudge,
  sendDormantAccountDeletionWarningEmail:   mockSendWarning,
}))

vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

import {
  runOnboardingNudges,
  runDeletionWarnings,
  runStaleAccountPrune,
} from '../lib/onboarding-followup'

beforeEach(() => {
  vi.clearAllMocks()
  mockSendNudge.mockResolvedValue(undefined)
  mockSendWarning.mockResolvedValue(undefined)
  mockLogEvent.mockResolvedValue(undefined)
})

/**
 * Helper: configure two sequential select() calls.
 * 1) The bulk eligibility query — innerJoin → where → limit.
 * 2) The per-row stripe re-check — from → where → limit.
 *
 * Both passes follow the same shape (race guard).
 */
function setupSelects(eligible: unknown[], freshStripeAccountId: string | null = null) {
  const limitFnBulk    = vi.fn().mockResolvedValue(eligible)
  const limitFnRecheck = vi.fn().mockResolvedValue([{ stripeAccountId: freshStripeAccountId }])

  // Bulk select chain: select().from().innerJoin().where().limit()
  const bulk = {
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({ limit: limitFnBulk })),
      })),
    })),
  }

  // Re-check chain: select().from().where().limit()
  const recheck = {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: limitFnRecheck })),
    })),
  }

  // Each per-row iteration calls recheck once. Build a queue.
  let calls = 0
  mockSelect.mockImplementation(() => {
    if (calls === 0) { calls++; return bulk }
    return recheck
  })
}

function setupUpdate() {
  mockUpdate.mockReturnValue({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  })
}

function setupDelete() {
  mockDelete.mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  })
}

// ---------------------------------------------------------------------------
// runOnboardingNudges (Pass A)
// ---------------------------------------------------------------------------

describe('runOnboardingNudges', () => {
  it('sends, updates, and logs for each eligible row', async () => {
    setupSelects([
      { customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: 'A' },
      { customerId: 'c2', userId: 'u2', email: 'b@x.co', founderName: null },
    ])
    setupUpdate()

    const result = await runOnboardingNudges({ dryRun: false })

    expect(result).toEqual({ processed: 2, sent: 2, errors: 0 })
    expect(mockSendNudge).toHaveBeenCalledTimes(2)
    expect(mockUpdate).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'onboarding_nudge_sent',
      customerId: 'c1',
    }))
  })

  it('skips rows whose stripeAccountId became non-null between bulk-select and send', async () => {
    setupSelects(
      [{ customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null }],
      'acct_now_connected',
    )
    setupUpdate()

    const result = await runOnboardingNudges({ dryRun: false })

    expect(result).toEqual({ processed: 1, sent: 0, errors: 0 })
    expect(mockSendNudge).not.toHaveBeenCalled()
  })

  it('respects dryRun: counts the row but does not send/update/log', async () => {
    setupSelects([{ customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null }])

    const result = await runOnboardingNudges({ dryRun: true })

    expect(result).toEqual({ processed: 1, sent: 1, errors: 0 })
    expect(mockSendNudge).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('continues the loop when one row throws', async () => {
    setupSelects([
      { customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null },
      { customerId: 'c2', userId: 'u2', email: 'b@x.co', founderName: null },
    ])
    setupUpdate()
    mockSendNudge.mockRejectedValueOnce(new Error('Resend down'))

    const result = await runOnboardingNudges({ dryRun: false })

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(1)
    expect(result.sent).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// runDeletionWarnings (Pass B)
// ---------------------------------------------------------------------------

describe('runDeletionWarnings', () => {
  it('sends warning + logs onboarding_deletion_warning_sent', async () => {
    setupSelects([{ customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: 'A' }])
    setupUpdate()

    const result = await runDeletionWarnings({ dryRun: false })

    expect(result).toEqual({ processed: 1, sent: 1, errors: 0 })
    expect(mockSendWarning).toHaveBeenCalledTimes(1)
    expect(mockSendNudge).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'onboarding_deletion_warning_sent',
      customerId: 'c1',
    }))
  })

  it('skips when stripeAccountId is now set (race guard)', async () => {
    setupSelects(
      [{ customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null }],
      'acct_now_connected',
    )
    setupUpdate()

    const result = await runDeletionWarnings({ dryRun: false })

    expect(result.sent).toBe(0)
    expect(mockSendWarning).not.toHaveBeenCalled()
  })

  it('respects dryRun', async () => {
    setupSelects([{ customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null }])

    const result = await runDeletionWarnings({ dryRun: true })

    expect(result).toEqual({ processed: 1, sent: 1, errors: 0 })
    expect(mockSendWarning).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// runStaleAccountPrune (Pass C)
// ---------------------------------------------------------------------------

describe('runStaleAccountPrune', () => {
  it('writes audit event with customerId:null BEFORE deleting, then deletes the user', async () => {
    const created = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)
    setupSelects([{
      customerId:  'c1',
      userId:      'u1',
      email:       'a@x.co',
      founderName: 'A',
      createdAt:   created,
    }])
    setupDelete()

    const callOrder: string[] = []
    mockLogEvent.mockImplementationOnce(async () => {
      callOrder.push('log')
    })
    mockDelete.mockImplementation(() => {
      callOrder.push('delete')
      return { where: vi.fn().mockResolvedValue(undefined) }
    })

    const result = await runStaleAccountPrune({ dryRun: false })

    expect(result).toEqual({ processed: 1, deleted: 1, errors: 0 })
    expect(callOrder).toEqual(['log', 'delete'])
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'onboarding_account_pruned',
      customerId: null,           // critical — audit row must survive cascade
      userId: 'u1',
      properties: expect.objectContaining({
        email:      'a@x.co',
        customerId: 'c1',
      }),
    }))
  })

  it('respects dryRun: writes audit but does not delete', async () => {
    setupSelects([{
      customerId:  'c1',
      userId:      'u1',
      email:       'a@x.co',
      founderName: null,
      createdAt:   new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
    }])

    const result = await runStaleAccountPrune({ dryRun: true })

    expect(result).toEqual({ processed: 1, deleted: 1, errors: 0 })
    expect(mockLogEvent).toHaveBeenCalledTimes(1)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('counts errors per row without aborting the loop', async () => {
    setupSelects([
      { customerId: 'c1', userId: 'u1', email: 'a@x.co', founderName: null, createdAt: new Date() },
      { customerId: 'c2', userId: 'u2', email: 'b@x.co', founderName: null, createdAt: new Date() },
    ])
    setupDelete()
    mockLogEvent.mockRejectedValueOnce(new Error('telemetry crash'))

    const result = await runStaleAccountPrune({ dryRun: false })

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(1)
    expect(result.deleted).toBe(1)
  })
})
