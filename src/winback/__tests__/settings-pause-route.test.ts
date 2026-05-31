/**
 * PR #169 — POST /api/settings/pause unit tests.
 *
 * Focus: the asymmetric pause/un-pause rule.
 *   - Pausing is always allowed.
 *   - Un-pausing (paused:false) is REFUSED with 403 when the merchant
 *     has no active platform subscription. This is the gate that stops
 *     the free-rider loop: "I'm done · pause" on the dashboard →
 *     un-pause in Settings → keep getting service without paying.
 *
 * Pattern mirrors send-promo-endpoint.test.ts: vi.mock swaps out
 * auth / db / drizzle / events / next-server so the route runs against
 * pure control-flow logic with no real DB or Stripe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAuth     = vi.hoisted(() => vi.fn())
const mockSelect   = vi.hoisted(() => vi.fn())
const mockUpdate   = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ auth: mockAuth }))
vi.mock('@/lib/db', () => ({ db: { select: mockSelect, update: mockUpdate } }))
vi.mock('@/lib/schema', () => ({
  customers: { id: 'id', userId: 'user_id', stripeSubscriptionId: 'stripe_subscription_id' },
}))
vi.mock('drizzle-orm', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }))
vi.mock('@/src/winback/lib/events', () => ({ logEvent: mockLogEvent }))
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}))

import { POST } from '@/app/api/settings/pause/route'

/** Drizzle select().from().where().limit() → resolves to rows. */
function selectReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/settings/pause', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
  // db.update().set().where() resolves by default.
  mockUpdate.mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve() }),
  }))
})

describe('POST /api/settings/pause — auth + body validation', () => {
  it('401 when no session', async () => {
    mockAuth.mockResolvedValueOnce(null)
    const res = await POST(makeReq({ scope: 'winback', paused: true }))
    expect(res.status).toBe(401)
  })

  it('400 on malformed body', async () => {
    const res = await POST(makeReq({ scope: 'nonsense', paused: 'yes' }))
    expect(res.status).toBe(400)
  })

  it('404 when the user has no customer row', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([]))
    const res = await POST(makeReq({ scope: 'winback', paused: true }))
    expect(res.status).toBe(404)
  })
})

describe('POST /api/settings/pause — pausing is always allowed', () => {
  it('pauses winback even with no subscription (200, writes pausedAt)', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([{ id: 'cust_1', stripeSubscriptionId: null }]))
    const res = await POST(makeReq({ scope: 'winback', paused: true }))
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'customer_paused' }),
    )
  })
})

describe('POST /api/settings/pause — un-pause requires an active subscription', () => {
  it('REFUSES un-pause with 403 subscribe_first when no sub on file', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([{ id: 'cust_2', stripeSubscriptionId: null }]))
    const res = await POST(makeReq({ scope: 'winback', paused: false }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toBe('subscribe_first')
    // Must NOT have written the un-pause, and must have logged the blocked attempt.
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'customer_unpause_blocked_no_sub' }),
    )
  })

  it('ALLOWS un-pause (200) when an active subscription exists', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([{ id: 'cust_3', stripeSubscriptionId: 'sub_live' }]))
    const res = await POST(makeReq({ scope: 'dunning', paused: false }))
    expect(res.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'customer_unpaused' }),
    )
  })
})
