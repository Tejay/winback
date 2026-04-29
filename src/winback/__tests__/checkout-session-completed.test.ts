/**
 * Spec 35 — processDunningPaymentUpdate (checkout.session.completed handler)
 *
 * Verifies:
 *  - Skips when subscriber missing
 *  - Skips when customer has no access token
 *  - Skips when session has no setup_intent (defensive)
 *  - Reads SetupIntent → extracts payment method ID
 *  - Attaches PM as customer's invoice_settings.default_payment_method
 *  - Lists open invoices for the subscription + calls invoices.pay on each
 *  - Logs dunning_payment_method_updated event with retry counts
 *  - Continues + counts failures when invoices.pay throws
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSetupIntentsRetrieve = vi.hoisted(() => vi.fn())
const mockCustomersUpdate      = vi.hoisted(() => vi.fn())
const mockInvoicesList         = vi.hoisted(() => vi.fn())
const mockInvoicesPay          = vi.hoisted(() => vi.fn())

vi.mock('stripe', () => ({
  default: class MockStripe {
    setupIntents = { retrieve: mockSetupIntentsRetrieve }
    customers    = { update:   mockCustomersUpdate }
    invoices     = { list:     mockInvoicesList, pay: mockInvoicesPay }
  },
}))

const mockDbSelect = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockDbSelect },
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: { id: 'churnedSubscribers.id' },
  customers:          { id: 'customers.id' },
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

import { processDunningPaymentUpdate } from '../lib/dunning-checkout'
import type Stripe from 'stripe'

function selectReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

function makeEvent(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Event {
  const session: Partial<Stripe.Checkout.Session> = {
    id: 'cs_1',
    setup_intent: 'seti_1',
    metadata: {
      winback_subscriber_id: 'sub_1',
      winback_customer_id:   'wb_cust_1',
      winback_flow:          'dunning_update_payment',
    },
    ...overrides,
  }
  return {
    id:    'evt_1',
    type:  'checkout.session.completed',
    data:  { object: session as Stripe.Checkout.Session },
    account: 'acct_merchant_1',
  } as unknown as Stripe.Event
}

beforeEach(() => {
  vi.clearAllMocks()

  mockSetupIntentsRetrieve.mockResolvedValue({
    id: 'seti_1',
    payment_method: 'pm_new_1',
  })
  mockCustomersUpdate.mockResolvedValue({})
  mockInvoicesList.mockResolvedValue({ data: [] })
  mockInvoicesPay.mockResolvedValue({})
})

describe('processDunningPaymentUpdate (Spec 35)', () => {
  it('returns early when subscriber row is missing', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([]))

    await processDunningPaymentUpdate(makeEvent())

    expect(mockSetupIntentsRetrieve).not.toHaveBeenCalled()
    expect(mockCustomersUpdate).not.toHaveBeenCalled()
    expect(mockInvoicesPay).not.toHaveBeenCalled()
  })

  it('returns early when customer has no Stripe access token', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id: 'sub_1', stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_stripe_x',
      }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: null }]))

    await processDunningPaymentUpdate(makeEvent())

    expect(mockSetupIntentsRetrieve).not.toHaveBeenCalled()
  })

  it('returns early when session has no setup_intent', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id: 'sub_1', stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_stripe_x',
      }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc' }]))

    await processDunningPaymentUpdate(makeEvent({ setup_intent: null }))

    expect(mockSetupIntentsRetrieve).not.toHaveBeenCalled()
    expect(mockCustomersUpdate).not.toHaveBeenCalled()
  })

  it('happy path: attaches PM, retries one open invoice, logs event', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id:                   'sub_1',
        stripeCustomerId:     'cus_stripe_1',
        stripeSubscriptionId: 'sub_stripe_1',
      }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc' }]))

    mockInvoicesList.mockResolvedValueOnce({
      data: [{ id: 'in_old', created: 100 }, { id: 'in_new', created: 200 }],
    })

    await processDunningPaymentUpdate(makeEvent())

    // SetupIntent fetched
    expect(mockSetupIntentsRetrieve).toHaveBeenCalledWith('seti_1')

    // PM attached as default
    expect(mockCustomersUpdate).toHaveBeenCalledWith('cus_stripe_1', {
      invoice_settings: { default_payment_method: 'pm_new_1' },
    })

    // Open invoices listed for THIS subscription
    expect(mockInvoicesList).toHaveBeenCalledWith({
      customer:     'cus_stripe_1',
      subscription: 'sub_stripe_1',
      status:       'open',
      limit:        5,
    })

    // Each open invoice retried, oldest first
    expect(mockInvoicesPay).toHaveBeenCalledTimes(2)
    expect(mockInvoicesPay).toHaveBeenNthCalledWith(1, 'in_old')
    expect(mockInvoicesPay).toHaveBeenNthCalledWith(2, 'in_new')

    // Audit event with counts
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'dunning_payment_method_updated',
      customerId: 'wb_cust_1',
      properties: expect.objectContaining({
        subscriberId:    'sub_1',
        paymentMethodId: 'pm_new_1',
        invoicesRetried: 2,
        retryFailures:   0,
      }),
    }))
  })

  it('continues when one invoices.pay throws and counts the failure', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id:                   'sub_1',
        stripeCustomerId:     'cus_stripe_1',
        stripeSubscriptionId: 'sub_stripe_1',
      }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc' }]))

    mockInvoicesList.mockResolvedValueOnce({
      data: [{ id: 'in_a', created: 100 }, { id: 'in_b', created: 200 }],
    })
    mockInvoicesPay.mockRejectedValueOnce(new Error('card declined'))
    mockInvoicesPay.mockResolvedValueOnce({})

    await processDunningPaymentUpdate(makeEvent())

    expect(mockInvoicesPay).toHaveBeenCalledTimes(2)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({
        invoicesRetried: 1,
        retryFailures:   1,
      }),
    }))
  })

  it('skips invoice retry when subscriber row has no stripeSubscriptionId', async () => {
    mockDbSelect
      .mockReturnValueOnce(selectReturning([{
        id:                   'sub_1',
        stripeCustomerId:     'cus_stripe_1',
        stripeSubscriptionId: null,
      }]))
      .mockReturnValueOnce(selectReturning([{ id: 'wb_cust_1', stripeAccessToken: 'enc' }]))

    await processDunningPaymentUpdate(makeEvent())

    // Still attaches PM as default — that's the main job.
    expect(mockCustomersUpdate).toHaveBeenCalled()

    // But no invoices listed or paid.
    expect(mockInvoicesList).not.toHaveBeenCalled()
    expect(mockInvoicesPay).not.toHaveBeenCalled()

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      properties: expect.objectContaining({
        invoicesRetried: 0,
        retryFailures:   0,
      }),
    }))
  })
})
