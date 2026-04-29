/**
 * Spec 35 — GET /api/update-payment/[subscriberId]
 *
 * Click-path before redirecting to Stripe Checkout.
 *
 * Verifies:
 *  - Creates a Checkout Session with mode: 'setup' + correct customer
 *  - Sets winback_flow metadata so the webhook can route the result
 *  - Records billingPortalClickedAt + lastEngagementAt before redirect
 *  - Logs link_clicked with linkType: 'checkout_setup'
 *  - Returns 302 to session.url
 *  - Bails to /welcome-back?recovered=false if subscriber not found,
 *    customer has no access token, or Checkout creation throws.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCheckoutSessionsCreate = vi.hoisted(() => vi.fn())
const mockSubscriptionsRetrieve  = vi.hoisted(() => vi.fn())

vi.mock('stripe', () => ({
  default: class MockStripe {
    checkout = {
      sessions: {
        create: mockCheckoutSessionsCreate,
      },
    }
    subscriptions = {
      retrieve: mockSubscriptionsRetrieve,
    }
  },
}))

const mockDbSelect = vi.hoisted(() => vi.fn())
const mockDbUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockDbSelect, update: mockDbUpdate },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: {
    id:                       'churnedSubscribers.id',
    customerId:               'churnedSubscribers.customerId',
    stripeCustomerId:         'churnedSubscribers.stripeCustomerId',
    billingPortalClickedAt:   'churnedSubscribers.billingPortalClickedAt',
    lastEngagementAt:         'churnedSubscribers.lastEngagementAt',
    updatedAt:                'churnedSubscribers.updatedAt',
  },
  customers: {
    id:                  'customers.id',
    stripeAccessToken:   'customers.stripeAccessToken',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
}))

vi.mock('@/src/winback/lib/encryption', () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
}))

const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { GET } from '../../../app/api/update-payment/[subscriberId]/route'

function selectReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

function makeReq(): Request {
  return new Request('http://localhost/api/update-payment/sub_1')
}

beforeEach(() => {
  vi.clearAllMocks()

  // db.update().set().where() chain — used to record click attribution.
  mockDbUpdate.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  })

  // Default — most tests use a sub with a real currency.
  mockSubscriptionsRetrieve.mockResolvedValue({
    id: 'sub_stripe_x', currency: 'gbp', status: 'past_due',
  })

  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
})

describe('GET /api/update-payment/[subscriberId]', () => {
  it('redirects to /welcome-back?recovered=false when subscriber missing', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([]))

    const res = await GET(makeReq() as never, { params: Promise.resolve({ subscriberId: 'sub_missing' }) })

    expect(res.status).toBe(307)  // NextResponse.redirect default
    expect(res.headers.get('location')).toBe('https://app.example.com/welcome-back?recovered=false')
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled()
  })

  it('redirects to /welcome-back?recovered=false when customer has no access token', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ id: 'sub_1', customerId: 'wb_cust_1', stripeCustomerId: 'cus_x' }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: null }]))

    const res = await GET(makeReq() as never, { params: Promise.resolve({ subscriberId: 'sub_1' }) })

    expect(res.headers.get('location')).toBe('https://app.example.com/welcome-back?recovered=false')
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled()
  })

  it('records click attribution + creates Checkout setup-mode session and redirects', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id:                   'sub_1',
        customerId:           'wb_cust_1',
        stripeCustomerId:     'cus_stripe_1',
        stripeSubscriptionId: 'sub_stripe_1',
      }]))
      .mockReturnValueOnce(selectReturning([{
        id:                'wb_cust_1',
        stripeAccessToken: 'enc_token',
      }]))

    mockCheckoutSessionsCreate.mockResolvedValue({
      id:  'cs_test_123',
      url: 'https://checkout.stripe.com/c/pay/cs_test_123',
    })

    const res = await GET(makeReq() as never, { params: Promise.resolve({ subscriberId: 'sub_1' }) })

    // Attribution write happened before the redirect
    expect(mockDbUpdate).toHaveBeenCalledTimes(1)
    const setArg = mockDbUpdate.mock.results[0].value.set.mock.calls[0][0]
    expect(setArg.billingPortalClickedAt).toBeInstanceOf(Date)
    expect(setArg.lastEngagementAt).toBeInstanceOf(Date)

    // link_clicked event with the Spec 35 linkType
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'link_clicked',
      properties: expect.objectContaining({
        subscriberId: 'sub_1',
        linkType:     'checkout_setup',
      }),
    }))

    // Subscription fetched to derive currency
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_stripe_1')

    // Checkout Session in setup mode with the right customer + metadata + currency
    expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1)
    const arg = mockCheckoutSessionsCreate.mock.calls[0][0]
    expect(arg.mode).toBe('setup')
    expect(arg.currency).toBe('gbp')
    expect(arg.customer).toBe('cus_stripe_1')
    expect(arg.success_url).toContain('/welcome-back?recovered=true')
    expect(arg.cancel_url).toContain('/welcome-back?recovered=false')
    expect(arg.metadata).toEqual({
      winback_subscriber_id: 'sub_1',
      winback_customer_id:   'wb_cust_1',
      winback_flow:          'dunning_update_payment',
    })

    // Redirect to the session URL
    expect(res.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_123')
  })

  it('falls back to usd when the subscription cannot be retrieved', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id:                   'sub_1',
        customerId:           'wb_cust_1',
        stripeCustomerId:     'cus_stripe_1',
        stripeSubscriptionId: 'sub_deleted',
      }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc' }]))

    mockSubscriptionsRetrieve.mockRejectedValueOnce(new Error('No such subscription'))
    mockCheckoutSessionsCreate.mockResolvedValue({ id: 'cs_x', url: 'https://checkout.stripe.com/c/pay/cs_x' })

    await GET(makeReq() as never, { params: Promise.resolve({ subscriberId: 'sub_1' }) })

    expect(mockCheckoutSessionsCreate.mock.calls[0][0].currency).toBe('usd')
  })

  it('uses usd when the row has no stripeSubscriptionId at all', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id:                   'sub_1',
        customerId:           'wb_cust_1',
        stripeCustomerId:     'cus_stripe_1',
        stripeSubscriptionId: null,
      }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc' }]))

    mockCheckoutSessionsCreate.mockResolvedValue({ id: 'cs_x', url: 'https://checkout.stripe.com/c/pay/cs_x' })

    await GET(makeReq() as never, { params: Promise.resolve({ subscriberId: 'sub_1' }) })

    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
    expect(mockCheckoutSessionsCreate.mock.calls[0][0].currency).toBe('usd')
  })

  it('redirects to /welcome-back?recovered=false when Stripe throws', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ id: 'sub_1', customerId: 'wb_cust_1', stripeCustomerId: 'cus_x' }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc_token' }]))

    mockCheckoutSessionsCreate.mockRejectedValue(new Error('Stripe API down'))

    const res = await GET(makeReq() as never, { params: Promise.resolve({ subscriberId: 'sub_1' }) })

    expect(res.headers.get('location')).toBe('https://app.example.com/welcome-back?recovered=false')
  })

  it('redirects to /welcome-back?recovered=false when Stripe returns no url', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{ id: 'sub_1', customerId: 'wb_cust_1', stripeCustomerId: 'cus_x' }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc_token' }]))

    mockCheckoutSessionsCreate.mockResolvedValue({ id: 'cs_test_no_url', url: null })

    const res = await GET(makeReq() as never, { params: Promise.resolve({ subscriberId: 'sub_1' }) })

    expect(res.headers.get('location')).toBe('https://app.example.com/welcome-back?recovered=false')
  })
})
