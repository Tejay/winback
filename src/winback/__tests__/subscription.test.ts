import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockStripe = vi.hoisted(() => ({
  subscriptions: {
    create: vi.fn(),
    retrieve: vi.fn(),
    update: vi.fn(),
  },
  prices: {
    list: vi.fn(),
    create: vi.fn(),
  },
  products: {
    create: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: 'wb_customers',
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
}))

vi.mock('../lib/platform-stripe', () => ({
  getPlatformStripe: () => mockStripe,
}))

const mockGetOrCreatePlatformCustomer = vi.hoisted(() =>
  vi.fn(async () => 'cus_test_platform'),
)
vi.mock('../lib/platform-billing', () => ({
  getOrCreatePlatformCustomer: mockGetOrCreatePlatformCustomer,
}))

import {
  ensurePlatformSubscription,
  cancelPlatformSubscription,
  getSubscriptionStatus,
  getSubscriptionDetails,
  reactivatePlatformSubscription,
  PLATFORM_FEE_CENTS,
} from '../lib/subscription'

function setupCustomerRow(row: {
  stripePlatformCustomerId: string | null
  stripeSubscriptionId: string | null
}) {
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => [row],
      }),
    }),
  }))
}

function setupNoCustomer() {
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => [],
      }),
    }),
  }))
}

function setupUpdateChain() {
  mockUpdate.mockImplementation(() => ({
    set: () => ({
      where: () => Promise.resolve(undefined),
    }),
  }))
}

describe('ensurePlatformSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.STRIPE_PLATFORM_FEE_PRICE_ID = 'price_test_99'
    setupUpdateChain()
  })

  it('creates a new subscription when none exists', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })
    mockStripe.subscriptions.create.mockResolvedValue({
      id: 'sub_new',
      status: 'active',
    })

    const result = await ensurePlatformSubscription('wb_cust_1')

    expect(result.created).toBe(true)
    expect(result.subscriptionId).toBe('sub_new')
    expect(mockStripe.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_existing',
        items: [{ price: 'price_test_99' }],
        proration_behavior: 'create_prorations',
        collection_method: 'charge_automatically',
      }),
    )
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('returns cached subscription when active in Stripe', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_existing',
    })
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_existing',
      status: 'active',
    })

    const result = await ensurePlatformSubscription('wb_cust_1')

    expect(result.created).toBe(false)
    expect(result.subscriptionId).toBe('sub_existing')
    expect(mockStripe.subscriptions.create).not.toHaveBeenCalled()
  })

  it('creates a new subscription when cached one is canceled', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_dead',
    })
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_dead',
      status: 'canceled',
    })
    mockStripe.subscriptions.create.mockResolvedValue({
      id: 'sub_new',
      status: 'active',
    })

    const result = await ensurePlatformSubscription('wb_cust_1')

    expect(result.created).toBe(true)
    expect(result.subscriptionId).toBe('sub_new')
  })

  it('throws when wb_customer not found', async () => {
    setupNoCustomer()
    await expect(ensurePlatformSubscription('wb_cust_missing')).rejects.toThrow(
      /not found/,
    )
  })

  it('uses STRIPE_PLATFORM_FEE_PRICE_ID env var when set', async () => {
    process.env.STRIPE_PLATFORM_FEE_PRICE_ID = 'price_env_override'
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })
    mockStripe.subscriptions.create.mockResolvedValue({
      id: 'sub_new',
      status: 'active',
    })

    await ensurePlatformSubscription('wb_cust_1')

    expect(mockStripe.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ price: 'price_env_override' }],
      }),
    )
    // No fallback to lookup_keys when env var is set
    expect(mockStripe.prices.list).not.toHaveBeenCalled()
  })

  it('falls back to lookup_keys when env var is missing', async () => {
    delete process.env.STRIPE_PLATFORM_FEE_PRICE_ID
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })
    mockStripe.prices.list.mockResolvedValue({
      data: [{ id: 'price_from_lookup' }],
    })
    mockStripe.subscriptions.create.mockResolvedValue({
      id: 'sub_new',
      status: 'active',
    })

    await ensurePlatformSubscription('wb_cust_1')

    expect(mockStripe.prices.list).toHaveBeenCalledWith(
      expect.objectContaining({
        lookup_keys: ['winback_platform_monthly_v1'],
        active: true,
      }),
    )
    expect(mockStripe.subscriptions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ price: 'price_from_lookup' }],
      }),
    )
  })

  it('creates Product + Price on first run when neither env nor lookup hits', async () => {
    delete process.env.STRIPE_PLATFORM_FEE_PRICE_ID
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })
    mockStripe.prices.list.mockResolvedValue({ data: [] })
    mockStripe.products.create.mockResolvedValue({ id: 'prod_new' })
    mockStripe.prices.create.mockResolvedValue({ id: 'price_new' })
    mockStripe.subscriptions.create.mockResolvedValue({
      id: 'sub_new',
      status: 'active',
    })

    await ensurePlatformSubscription('wb_cust_1')

    expect(mockStripe.products.create).toHaveBeenCalled()
    expect(mockStripe.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product: 'prod_new',
        unit_amount: PLATFORM_FEE_CENTS,
        currency: 'usd',
        recurring: { interval: 'month' },
        lookup_key: 'winback_platform_monthly_v1',
      }),
    )
  })
})

describe('cancelPlatformSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateChain()
  })

  it('marks subscription cancel_at_period_end', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_active',
    })
    mockStripe.subscriptions.update.mockResolvedValue({})

    await cancelPlatformSubscription('wb_cust_1')

    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_active', {
      cancel_at_period_end: true,
    })
  })

  it('is a no-op when no subscription exists', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })

    await cancelPlatformSubscription('wb_cust_1')

    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled()
  })
})

describe('getSubscriptionStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the Stripe status', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_x',
    })
    mockStripe.subscriptions.retrieve.mockResolvedValue({ status: 'active' })

    const status = await getSubscriptionStatus('wb_cust_1')
    expect(status).toBe('active')
  })

  it('returns null when no subscription is on file', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })

    const status = await getSubscriptionStatus('wb_cust_1')
    expect(status).toBeNull()
  })

  it('returns null on Stripe lookup failure', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_x',
    })
    mockStripe.subscriptions.retrieve.mockRejectedValue(new Error('not found'))

    const status = await getSubscriptionStatus('wb_cust_1')
    expect(status).toBeNull()
  })
})

describe('getSubscriptionDetails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns full details including cancel_at_period_end and current_period_end', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_x',
    })
    const periodEndUnix = 1735689600 // 2025-01-01 00:00:00 UTC
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_x',
      status: 'active',
      cancel_at_period_end: true,
      current_period_end: periodEndUnix,
    })

    const details = await getSubscriptionDetails('wb_cust_1')

    expect(details).toEqual({
      subscriptionId: 'sub_x',
      status: 'active',
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(periodEndUnix * 1000),
    })
  })

  it('returns null when no subscription is on file', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })

    const details = await getSubscriptionDetails('wb_cust_1')
    expect(details).toBeNull()
  })

  it('defaults cancelAtPeriodEnd to false when Stripe omits it', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_x',
    })
    mockStripe.subscriptions.retrieve.mockResolvedValue({
      id: 'sub_x',
      status: 'active',
      current_period_end: 1735689600,
    })

    const details = await getSubscriptionDetails('wb_cust_1')
    expect(details?.cancelAtPeriodEnd).toBe(false)
  })
})

describe('reactivatePlatformSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears cancel_at_period_end on the subscription', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: 'sub_x',
    })
    mockStripe.subscriptions.update.mockResolvedValue({})

    await reactivatePlatformSubscription('wb_cust_1')

    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith('sub_x', {
      cancel_at_period_end: false,
    })
  })

  it('is a no-op when no subscription exists', async () => {
    setupCustomerRow({
      stripePlatformCustomerId: 'cus_existing',
      stripeSubscriptionId: null,
    })

    await reactivatePlatformSubscription('wb_cust_1')
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled()
  })
})
