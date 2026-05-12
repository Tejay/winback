import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Spec 64 — Inbound webhook dedup.
 *
 * The full POST handler integration is left to manual smoke (Spec 63 Layer
 * 3) because mocking the entire dependency tree (Svix, classifier, Resend,
 * email helpers, founder-handoff) doesn't add much over testing the two
 * primitives directly. These tests cover the reserve/finalize behaviour
 * that drives the gate.
 */

const mockInsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({
  db: {
    insert: mockInsert,
    update: mockUpdate,
  },
}))

vi.mock('@/lib/schema', () => ({
  emailsSent: { subscriberId: 'subscriber_id' },
  churnedSubscribers: { id: 'id' },
  customers: {},
  users: {},
  inboundEvents: { emailId: 'email_id', outcome: 'outcome', subscriberId: 'subscriber_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ a, b })),
  count: vi.fn(() => 'count'),
}))

vi.mock('svix', () => ({ Webhook: class {} }))
vi.mock('resend', () => ({ Resend: class {} }))
vi.mock('@/src/winback/lib/classifier', () => ({ classifySubscriber: vi.fn() }))
vi.mock('@/src/winback/lib/email', () => ({
  sendReplyEmail: vi.fn(),
  resolveFounderNotificationEmail: vi.fn(),
}))
vi.mock('@/src/winback/lib/founder-handoff-email', () => ({
  buildReplyAfterHandoffNotification: vi.fn(),
}))
vi.mock('@/src/winback/lib/events', () => ({ logEvent: vi.fn() }))

import { reserveInboundEvent, finalizeInboundEvent } from '@/app/api/email/inbound/route'

describe('reserveInboundEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('returns true when this is the first time we see the email_id', async () => {
    // insert().values().onConflictDoNothing().returning() → [{ emailId }]
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ emailId: 'em_new' }]),
        }),
      }),
    })

    const result = await reserveInboundEvent('em_new')
    expect(result).toBe(true)
  })

  it('returns false when the email_id is already reserved (PK conflict → 0 rows)', async () => {
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    })

    const result = await reserveInboundEvent('em_dupe')
    expect(result).toBe(false)
  })

  it('inserts with outcome="reserved" so a crashed mid-flow webhook is visible in /admin', async () => {
    const valuesMock = vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ emailId: 'em_xyz' }]),
      }),
    })
    mockInsert.mockReturnValue({ values: valuesMock })

    await reserveInboundEvent('em_xyz')

    expect(valuesMock).toHaveBeenCalledWith({
      emailId: 'em_xyz',
      outcome: 'reserved',
    })
  })
})

describe('finalizeInboundEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('updates the row to the terminal outcome', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    })
    mockUpdate.mockReturnValue({ set: setMock })

    await finalizeInboundEvent('em_1', 'processed', 'sub_1')

    expect(setMock).toHaveBeenCalledWith({
      outcome: 'processed',
      subscriberId: 'sub_1',
    })
  })

  it('handles each terminal outcome', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    })
    mockUpdate.mockReturnValue({ set: setMock })

    const outcomes = [
      'processed',
      'no_subscriber_id',
      'subscriber_not_found',
      'empty_reply_text',
    ] as const

    for (const o of outcomes) {
      await finalizeInboundEvent('em_x', o)
    }

    expect(setMock).toHaveBeenCalledTimes(outcomes.length)
    outcomes.forEach((o, i) => {
      expect(setMock.mock.calls[i][0]).toMatchObject({ outcome: o })
    })
  })

  it('persists subscriber_id when one was resolved (cross-ref for forensics)', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    })
    mockUpdate.mockReturnValue({ set: setMock })

    await finalizeInboundEvent('em_2', 'empty_reply_text', 'sub_abc')

    expect(setMock.mock.calls[0][0]).toMatchObject({ subscriberId: 'sub_abc' })
  })

  it('persists subscriber_id as null when none was resolved', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    })
    mockUpdate.mockReturnValue({ set: setMock })

    await finalizeInboundEvent('em_3', 'no_subscriber_id')

    expect(setMock.mock.calls[0][0]).toMatchObject({ subscriberId: null })
  })

  it('is a no-op when emailId is empty (no row was reserved)', async () => {
    await finalizeInboundEvent('', 'processed', 'sub_anything')

    expect(mockUpdate).not.toHaveBeenCalled()
  })
})
