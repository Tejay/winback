/**
 * Spec 72 — runBackfillIngestTick tests.
 *
 * Verifies:
 *  - Atomic claim: returns no row when lock is held / completed
 *  - Cursor advances on has_more = true
 *  - backfill_completed_at set on has_more = false
 *  - Lock released on error
 *
 * The Stripe API call + extractSignals are mocked; we're testing the
 * tick's state-machine, not the external integrations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUpdate         = vi.hoisted(() => vi.fn())
const mockInsert         = vi.hoisted(() => vi.fn())
const mockExtractSignals = vi.hoisted(() => vi.fn())
const mockGetConnect     = vi.hoisted(() => vi.fn())
const mockDecrypt        = vi.hoisted(() => vi.fn((s: string) => `decrypted-${s}`))
const mockLogEvent       = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/db', () => ({
  db: { update: mockUpdate, insert: mockInsert },
}))

vi.mock('@/lib/schema', () => ({
  customers: {
    id: 'id',
    backfillCursor: 'backfill_cursor',
    backfillCompletedAt: 'backfill_completed_at',
    backfillProcessingAt: 'backfill_processing_at',
    backfillProcessed: 'backfill_processed',
  },
  churnedSubscribers: {
    id: 'id',
    customerId: 'customer_id',
    stripeCustomerId: 'stripe_customer_id',
  },
}))

vi.mock('drizzle-orm', () => ({
  and:    vi.fn((...args: unknown[]) => ({ and: args })),
  eq:     vi.fn((a, b) => ({ eq: [a, b] })),
  isNull: vi.fn((c) => ({ isNull: c })),
  or:     vi.fn((...args: unknown[]) => ({ or: args })),
  sql:    Object.assign(
    (..._args: unknown[]) => ({ sql: 'mock' }),
    { raw: (s: string) => s },
  ),
}))

vi.mock('../lib/encryption', () => ({ decrypt: mockDecrypt }))
vi.mock('../lib/stripe', () => ({
  extractSignals: mockExtractSignals,
  getConnectStripe: mockGetConnect,
}))
vi.mock('../lib/events', () => ({ logEvent: mockLogEvent }))

import { runBackfillIngestTick } from '../lib/backfill'

function updateClaimReturning(rows: unknown[]) {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

function updateNoReturn() {
  return {
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function insertReturning(returnedRows: unknown[] = [{ id: 'sub_new' }]) {
  return {
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returnedRows),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockExtractSignals.mockResolvedValue({
    stripeCustomerId: 'cus_a',
    stripeSubscriptionId: 'sub_a',
    stripePriceId: null,
    email: 'a@example.com',
    name: 'A',
    planName: 'Pro',
    mrrCents: 2900,
    tenureDays: 90,
    everUpgraded: false,
    nearRenewal: false,
    paymentFailures: 0,
    previousSubs: 0,
    stripeEnum: null,
    stripeComment: null,
    cancelledAt: new Date(),
  })
})

describe('runBackfillIngestTick', () => {
  it('returns skipped/claim_failed when the lock is held or backfill complete', async () => {
    // Empty returning array means UPDATE matched nothing — the WHERE
    // clause filtered out this customer (already done OR lock held).
    mockUpdate.mockReturnValueOnce(updateClaimReturning([]))

    const result = await runBackfillIngestTick('cust_1')
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') expect(result.reason).toBe('claim_failed')
  })

  it('returns skipped/no_token when stripeAccessToken is null', async () => {
    mockUpdate
      .mockReturnValueOnce(updateClaimReturning([{
        backfillCursor: null, stripeAccessToken: null, backfillProcessed: 0,
      }]))
      .mockReturnValueOnce(updateNoReturn())  // release lock

    const result = await runBackfillIngestTick('cust_1')
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') expect(result.reason).toBe('no_token')
  })

  it('progress: has_more=true advances cursor', async () => {
    mockUpdate
      .mockReturnValueOnce(updateClaimReturning([{
        backfillCursor: null,
        stripeAccessToken: 'tok',
        backfillProcessed: 0,
      }]))
      .mockReturnValueOnce(updateNoReturn())  // final state update
    mockInsert.mockReturnValue(insertReturning([{ id: 'sub_new' }]))
    mockGetConnect.mockReturnValue({
      subscriptions: {
        list: vi.fn().mockResolvedValue({
          data: [
            { id: 'sub_1', canceled_at: Math.floor(Date.now() / 1000), customer: 'cus_a' },
          ],
          has_more: true,
        }),
      },
    })

    const result = await runBackfillIngestTick('cust_1')
    expect(result.kind).toBe('progress')
    if (result.kind === 'progress') {
      expect(result.rowsThisTick).toBe(1)
      expect(result.cursorAdvancedTo).toBe('sub_1')
    }
  })

  it('completed: has_more=false sets backfill_completed_at', async () => {
    mockUpdate
      .mockReturnValueOnce(updateClaimReturning([{
        backfillCursor: 'sub_prev',
        stripeAccessToken: 'tok',
        backfillProcessed: 10,
      }]))
      .mockReturnValueOnce(updateNoReturn())
    mockInsert.mockReturnValue(insertReturning([]))   // empty page; nothing to insert
    mockGetConnect.mockReturnValue({
      subscriptions: {
        list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
      },
    })

    const result = await runBackfillIngestTick('cust_1')
    expect(result.kind).toBe('completed')
  })

  it('error: releases lock + logs backfill_failed event', async () => {
    mockUpdate
      .mockReturnValueOnce(updateClaimReturning([{
        backfillCursor: null, stripeAccessToken: 'tok', backfillProcessed: 0,
      }]))
      .mockReturnValueOnce(updateNoReturn())  // release lock
    mockGetConnect.mockReturnValue({
      subscriptions: {
        list: vi.fn().mockRejectedValue(new Error('Stripe down')),
      },
    })

    const result = await runBackfillIngestTick('cust_1')
    expect(result.kind).toBe('error')
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'backfill_failed',
      properties: expect.objectContaining({ errorMessage: 'Stripe down' }),
    }))
  })
})
