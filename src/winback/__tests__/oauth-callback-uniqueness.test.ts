/**
 * Spec 56 — OAuth callback rejects re-linking a Stripe account that
 * another Winback customer already owns.
 *
 * Four cases:
 *   (a) first connect on a fresh Stripe account              → 302 /dashboard
 *   (b) same user re-OAuths the SAME Stripe account          → 302 /dashboard
 *   (c) different user OAuths an already-linked Stripe acct  → 302 /onboarding/stripe?error=account_already_linked
 *   (d) Spec 49 — same user switching to a different acct    → 302 /dashboard
 *
 * The mock for db.select() returns results in the order the route
 * issues queries:
 *   1st call — customers WHERE id = state      (current row lookup)
 *   2nd call — customers WHERE stripeAccountId = newAccountId AND id != state (conflict check)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockEncrypt = vi.hoisted(() => vi.fn((s: string) => `enc(${s})`))
const mockFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: {
    id: 'cust.id',
    stripeAccountId: 'cust.stripe_account_id',
    userId: 'cust.user_id',
  },
  churnedSubscribers: {},
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args) => ({ op: 'and', args })),
  ne: vi.fn((a, b) => ({ op: 'ne', a, b })),
}))

vi.mock('@/src/winback/lib/encryption', () => ({
  encrypt: mockEncrypt,
}))

vi.mock('@/src/winback/lib/stripe', () => ({
  extractSignals: vi.fn(),
}))

vi.mock('@/src/winback/lib/classifier', () => ({
  classifySubscriber: vi.fn(),
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

// stripe SDK not used by GET path beyond OAuth fetch — stub it
vi.mock('stripe', () => ({
  default: class {},
}))

// process.env must be set before importing the route — it reads NEXTAUTH_URL
// via `baseUrl()` for redirect targets.
process.env.NEXTAUTH_URL = 'http://localhost:3000'
process.env.STRIPE_SECRET_KEY = 'sk_test_fake'

// global.fetch is what the route uses to call connect.stripe.com/oauth/token
;(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch

import { GET } from '../../../app/api/stripe/callback/route'

const STATE = 'cust-A'
const NEW_ACCOUNT_ID = 'acct_NEW'

function makeRequest(params: Record<string, string>) {
  const url = new URL('http://localhost:3000/api/stripe/callback')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  // Minimal shape — the route only reads `req.nextUrl.searchParams`
  return { nextUrl: url } as unknown as Parameters<typeof GET>[0]
}

function arrangeSelect(currentCustomer: Record<string, unknown> | null, conflict: Record<string, unknown> | null) {
  let call = 0
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => {
          call += 1
          if (call === 1) return currentCustomer ? [currentCustomer] : []
          if (call === 2) return conflict ? [conflict] : []
          return []
        },
      }),
    }),
  }))
}

function arrangeUpdateNoOp() {
  mockUpdate.mockReturnValue({
    set: () => ({ where: () => Promise.resolve() }),
  })
}

function arrangeStripeOAuthOk(accountId: string) {
  // 1st fetch: OAuth token exchange at connect.stripe.com/oauth/token
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: 'rk_test_abc', stripe_user_id: accountId }),
  })
  // 2nd fetch (only when first-connect or account-change): fire-and-forget
  // POST /api/backfill/start. Tests that hit the conflict branch never reach
  // this second fetch — the extra mock is harmless there.
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) })
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks resets call history but does NOT drain queued
  // mockResolvedValueOnce values — explicitly reset the fetch queue so
  // leftover responses from a prior test don't poison the current one.
  mockFetch.mockReset()
  arrangeUpdateNoOp()
})

describe('Spec 56 — OAuth callback conflict check', () => {
  it('(a) first-connect on fresh Stripe account → /dashboard', async () => {
    arrangeSelect(
      { id: STATE, userId: 'u-A', stripeAccountId: null },
      null,
    )
    arrangeStripeOAuthOk(NEW_ACCOUNT_ID)

    const res = await GET(makeRequest({ code: 'c', state: STATE }))

    expect(res.status).toBe(307) // NextResponse.redirect default
    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard')
    // No oauth_error event fired
    const errorEvents = mockLogEvent.mock.calls.filter(c => c[0]?.name === 'oauth_error')
    expect(errorEvents).toHaveLength(0)
  })

  it('(b) same user re-OAuths same Stripe account → /dashboard (idempotent)', async () => {
    arrangeSelect(
      { id: STATE, userId: 'u-A', stripeAccountId: NEW_ACCOUNT_ID }, // already linked to this account
      null, // conflict check excludes self → no conflict
    )
    arrangeStripeOAuthOk(NEW_ACCOUNT_ID)

    const res = await GET(makeRequest({ code: 'c', state: STATE }))

    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard')
    expect(mockLogEvent.mock.calls.filter(c => c[0]?.name === 'oauth_error')).toHaveLength(0)
  })

  it('(c) different user OAuths an already-linked Stripe acct → /onboarding/stripe?error=account_already_linked', async () => {
    arrangeSelect(
      { id: STATE, userId: 'u-A', stripeAccountId: null },
      { id: 'cust-B' }, // a DIFFERENT customer already owns NEW_ACCOUNT_ID
    )
    arrangeStripeOAuthOk(NEW_ACCOUNT_ID)

    const res = await GET(makeRequest({ code: 'c', state: STATE }))

    expect(res.headers.get('location')).toBe(
      'http://localhost:3000/onboarding/stripe?error=account_already_linked',
    )
    // db.update must NOT have been called — the original linkage stays intact
    expect(mockUpdate).not.toHaveBeenCalled()
    // oauth_error event with the right errorType
    const errs = mockLogEvent.mock.calls.filter(c => c[0]?.name === 'oauth_error')
    expect(errs).toHaveLength(1)
    expect(errs[0][0].properties).toMatchObject({
      errorType: 'account_already_linked',
      newAccountId: NEW_ACCOUNT_ID,
      conflictingCustomerId: 'cust-B',
    })
  })

  it('(d) Spec 49 — same user switching to a different (free) Stripe account → /dashboard', async () => {
    arrangeSelect(
      { id: STATE, userId: 'u-A', stripeAccountId: 'acct_OLD' }, // had one
      null, // NEW_ACCOUNT_ID isn't claimed by anyone else
    )
    arrangeStripeOAuthOk(NEW_ACCOUNT_ID)

    const res = await GET(makeRequest({ code: 'c', state: STATE }))

    expect(res.headers.get('location')).toBe('http://localhost:3000/dashboard')
    expect(mockUpdate).toHaveBeenCalled()
    // oauth_account_changed should fire (Spec 49 audit log)
    const changed = mockLogEvent.mock.calls.filter(c => c[0]?.name === 'oauth_account_changed')
    expect(changed).toHaveLength(1)
    expect(changed[0][0].properties).toMatchObject({
      previousAccountId: 'acct_OLD',
      newAccountId: NEW_ACCOUNT_ID,
    })
  })
})
