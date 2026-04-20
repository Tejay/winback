import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for spec 23 — platform billing card capture.
 *
 * Unit tests covering the key decision logic and helpers. Full
 * end-to-end with Stripe Checkout is manual (see spec 23 verification).
 */

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockStripeCustomersCreate = vi.hoisted(() => vi.fn())
const mockStripeCustomersRetrieve = vi.hoisted(() => vi.fn())
const mockStripeCustomersUpdate = vi.hoisted(() => vi.fn())
const mockStripePaymentMethodsDetach = vi.hoisted(() => vi.fn())

vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      customers = {
        create: mockStripeCustomersCreate,
        retrieve: mockStripeCustomersRetrieve,
        update: mockStripeCustomersUpdate,
      }
      paymentMethods = {
        detach: mockStripePaymentMethodsDetach,
      }
    },
  }
})

const mockDbSelect = vi.hoisted(() => vi.fn())
const mockDbUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
  },
}))

vi.mock('@/lib/schema', () => ({
  customers: { id: 'customers.id', userId: 'customers.userId', stripePlatformCustomerId: 'customers.stripePlatformCustomerId' },
  users: { id: 'users.id', email: 'users.email' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
}))

beforeEach(() => {
  mockStripeCustomersCreate.mockReset()
  mockStripeCustomersRetrieve.mockReset()
  mockStripeCustomersUpdate.mockReset()
  mockStripePaymentMethodsDetach.mockReset()
  mockDbSelect.mockReset()
  mockDbUpdate.mockReset()
  process.env.STRIPE_SECRET_KEY = 'sk_test_123'
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('getOrCreatePlatformCustomer (spec 23)', () => {
  it('returns existing ID without hitting Stripe when already populated', async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            { id: 'wb-1', userId: 'user-1', founderName: 'Tej', stripePlatformCustomerId: 'cus_existing' },
          ]),
        }),
      }),
    })

    const { getOrCreatePlatformCustomer } = await import('../lib/platform-billing')
    const id = await getOrCreatePlatformCustomer('wb-1')
    expect(id).toBe('cus_existing')
    expect(mockStripeCustomersCreate).not.toHaveBeenCalled()
  })

  it('creates a new Stripe customer + persists the ID when none exists', async () => {
    const selectChain = vi.fn()
      // First call — wb customer lookup
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'wb-1', userId: 'user-1', founderName: 'Tej', stripePlatformCustomerId: null },
            ]),
          }),
        }),
      })
      // Second call — user email lookup
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ email: 'tej@example.com' }]),
          }),
        }),
      })
    mockDbSelect.mockImplementation(selectChain)

    mockStripeCustomersCreate.mockResolvedValue({ id: 'cus_new_123' })

    mockDbUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue({}),
      }),
    })

    const { getOrCreatePlatformCustomer } = await import('../lib/platform-billing')
    const id = await getOrCreatePlatformCustomer('wb-1')
    expect(id).toBe('cus_new_123')
    expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
      email: 'tej@example.com',
      name: 'Tej',
      metadata: {
        winback_customer_id: 'wb-1',
        winback_user_id: 'user-1',
      },
    })
    expect(mockDbUpdate).toHaveBeenCalled()
  })

  it('throws when wb_customer is not found', async () => {
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    })

    const { getOrCreatePlatformCustomer } = await import('../lib/platform-billing')
    await expect(getOrCreatePlatformCustomer('missing')).rejects.toThrow(/not found/)
  })
})

describe('fetchPlatformPaymentMethod (spec 23)', () => {
  it('returns null when platformCustomerId is null', async () => {
    const { fetchPlatformPaymentMethod } = await import('../lib/platform-billing')
    const result = await fetchPlatformPaymentMethod(null)
    expect(result).toBeNull()
    expect(mockStripeCustomersRetrieve).not.toHaveBeenCalled()
  })

  it('returns card summary when default PM exists', async () => {
    mockStripeCustomersRetrieve.mockResolvedValue({
      id: 'cus_123',
      deleted: false,
      invoice_settings: {
        default_payment_method: {
          id: 'pm_abc',
          card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
        },
      },
    })

    const { fetchPlatformPaymentMethod } = await import('../lib/platform-billing')
    const result = await fetchPlatformPaymentMethod('cus_123')
    expect(result).toEqual({
      id: 'pm_abc',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    })
  })

  it('returns null when customer has no default PM', async () => {
    mockStripeCustomersRetrieve.mockResolvedValue({
      id: 'cus_123',
      deleted: false,
      invoice_settings: { default_payment_method: null },
    })

    const { fetchPlatformPaymentMethod } = await import('../lib/platform-billing')
    const result = await fetchPlatformPaymentMethod('cus_123')
    expect(result).toBeNull()
  })

  it('returns null on Stripe API error (swallowed)', async () => {
    mockStripeCustomersRetrieve.mockRejectedValue(new Error('Stripe down'))
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { fetchPlatformPaymentMethod } = await import('../lib/platform-billing')
    const result = await fetchPlatformPaymentMethod('cus_123')
    expect(result).toBeNull()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('returns null when default PM is just an ID (unexpanded)', async () => {
    mockStripeCustomersRetrieve.mockResolvedValue({
      id: 'cus_123',
      deleted: false,
      invoice_settings: { default_payment_method: 'pm_abc' }, // string, not object
    })

    const { fetchPlatformPaymentMethod } = await import('../lib/platform-billing')
    const result = await fetchPlatformPaymentMethod('cus_123')
    expect(result).toBeNull()
  })
})

describe('Webhook dispatch decision (spec 23)', () => {
  // Documents the rule in app/api/stripe/webhook/route.ts —
  // checkout.session.completed is dispatched to different handlers
  // based on session.metadata.

  type Route = 'platform_card_capture' | 'checkout_recovery' | 'ignore'

  function routeCheckoutSession(metadata: Record<string, string> | null | undefined): Route {
    if (metadata?.flow === 'platform_card_capture') return 'platform_card_capture'
    if (metadata?.winback_subscriber_id) return 'checkout_recovery'
    return 'ignore'
  }

  it('metadata.flow=platform_card_capture → card capture handler', () => {
    expect(routeCheckoutSession({ flow: 'platform_card_capture' })).toBe('platform_card_capture')
  })

  it('metadata.winback_subscriber_id → recovery handler', () => {
    expect(routeCheckoutSession({ winback_subscriber_id: 'sub-123' })).toBe('checkout_recovery')
  })

  it('both fields present → card capture wins (checked first)', () => {
    expect(routeCheckoutSession({
      flow: 'platform_card_capture',
      winback_subscriber_id: 'sub-123',
    })).toBe('platform_card_capture')
  })

  it('no known metadata → ignored', () => {
    expect(routeCheckoutSession({})).toBe('ignore')
    expect(routeCheckoutSession(null)).toBe('ignore')
    expect(routeCheckoutSession(undefined)).toBe('ignore')
  })

  it('unknown flow value → ignored', () => {
    expect(routeCheckoutSession({ flow: 'other' })).toBe('ignore')
  })
})

describe('Add vs Update detection (spec 23)', () => {
  // When the webhook processes a platform card capture, it needs to know
  // if this is an Add (no previous PM) or Update (previous PM exists →
  // detach after swapping default).

  function classifyCapture(previousPmId: string | null, newPmId: string): 'add' | 'update' | 'noop' {
    if (!previousPmId) return 'add'
    if (previousPmId === newPmId) return 'noop'
    return 'update'
  }

  it('no previous PM → add', () => {
    expect(classifyCapture(null, 'pm_new')).toBe('add')
  })

  it('different previous PM → update', () => {
    expect(classifyCapture('pm_old', 'pm_new')).toBe('update')
  })

  it('same PM (re-ran setup somehow) → noop', () => {
    expect(classifyCapture('pm_same', 'pm_same')).toBe('noop')
  })
})

describe('Payment method display — brand label normalization (spec 23)', () => {
  // Mirrors the brandLabel function in payment-method-section.tsx
  function brandLabel(brand: string): string {
    const lower = brand.toLowerCase()
    if (lower === 'visa') return 'Visa'
    if (lower === 'mastercard') return 'Mastercard'
    if (lower === 'amex') return 'Amex'
    if (lower === 'discover') return 'Discover'
    return brand.charAt(0).toUpperCase() + brand.slice(1)
  }

  it('normalizes common brands', () => {
    expect(brandLabel('visa')).toBe('Visa')
    expect(brandLabel('VISA')).toBe('Visa')
    expect(brandLabel('mastercard')).toBe('Mastercard')
    expect(brandLabel('amex')).toBe('Amex')
    expect(brandLabel('discover')).toBe('Discover')
  })

  it('title-cases unknown brands', () => {
    expect(brandLabel('diners')).toBe('Diners')
    expect(brandLabel('unionpay')).toBe('Unionpay')
  })
})
