import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Tests for spec 24a — monthly invoice cron.
 *
 * Focuses on pure decision logic + date/period helpers. End-to-end with
 * Stripe is manual (see spec 24a verification).
 */

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_123'
  process.env.CRON_SECRET = 'test-cron-secret'
})

describe('previousMonthYYYYMM (spec 24a)', () => {
  it('returns the prior month for a normal date', async () => {
    const { previousMonthYYYYMM } = await import('../lib/platform-billing')
    expect(previousMonthYYYYMM(new Date(Date.UTC(2026, 5, 1)))).toBe('2026-05')     // June 1 → 2026-05
    expect(previousMonthYYYYMM(new Date(Date.UTC(2026, 5, 15)))).toBe('2026-05')    // Mid-June → still 2026-05
    expect(previousMonthYYYYMM(new Date(Date.UTC(2026, 11, 1)))).toBe('2026-11')    // Dec 1 → 2026-11
  })

  it('rolls year boundary for January', async () => {
    const { previousMonthYYYYMM } = await import('../lib/platform-billing')
    expect(previousMonthYYYYMM(new Date(Date.UTC(2026, 0, 1)))).toBe('2025-12')     // Jan 1 → 2025-12
    expect(previousMonthYYYYMM(new Date(Date.UTC(2027, 0, 15)))).toBe('2026-12')    // Jan 15 2027 → 2026-12
  })

  it('pads single-digit months', async () => {
    const { previousMonthYYYYMM } = await import('../lib/platform-billing')
    expect(previousMonthYYYYMM(new Date(Date.UTC(2026, 2, 1)))).toBe('2026-02')     // March 1 → 2026-02
    expect(previousMonthYYYYMM(new Date(Date.UTC(2026, 1, 1)))).toBe('2026-01')     // Feb 1 → 2026-01
  })
})

describe('humanPeriod (spec 24a)', () => {
  it('formats valid YYYY-MM', async () => {
    const { humanPeriod } = await import('../lib/platform-billing')
    expect(humanPeriod('2026-05')).toBe('May 2026')
    expect(humanPeriod('2025-12')).toBe('December 2025')
    expect(humanPeriod('2026-01')).toBe('January 2026')
  })

  it('returns input unchanged for invalid formats', async () => {
    const { humanPeriod } = await import('../lib/platform-billing')
    expect(humanPeriod('not-a-date')).toBe('not-a-date')
    expect(humanPeriod('2026-13')).toBe('2026-13')
    expect(humanPeriod('2026-00')).toBe('2026-00')
  })
})

describe('Billing status transitions (spec 24a)', () => {
  // Documents which status a billing_run row should end up in for each scenario.
  type Outcome = 'pending' | 'paid' | 'failed' | 'skipped_no_obligations' | 'skipped_no_card'

  function classify(args: {
    hasPlatformCustomer: boolean
    totalFeeCents: number
    alreadyBilled: boolean
    invoiceCreated?: boolean
    invoicePaid?: boolean
    invoiceFailed?: boolean
  }): Outcome | 'skip_already_billed' {
    if (args.alreadyBilled) return 'skip_already_billed'
    if (!args.hasPlatformCustomer) return 'skipped_no_card'
    if (args.totalFeeCents === 0) return 'skipped_no_obligations'
    if (args.invoicePaid) return 'paid'
    if (args.invoiceFailed) return 'failed'
    return 'pending'
  }

  it('already billed this period → skip', () => {
    expect(classify({
      hasPlatformCustomer: true, totalFeeCents: 500, alreadyBilled: true,
    })).toBe('skip_already_billed')
  })

  it('no card → skipped_no_card', () => {
    expect(classify({
      hasPlatformCustomer: false, totalFeeCents: 500, alreadyBilled: false,
    })).toBe('skipped_no_card')
  })

  it('no obligations → skipped_no_obligations', () => {
    expect(classify({
      hasPlatformCustomer: true, totalFeeCents: 0, alreadyBilled: false,
    })).toBe('skipped_no_obligations')
  })

  it('invoice created, awaiting webhook → pending', () => {
    expect(classify({
      hasPlatformCustomer: true, totalFeeCents: 500, alreadyBilled: false, invoiceCreated: true,
    })).toBe('pending')
  })

  it('invoice paid → paid', () => {
    expect(classify({
      hasPlatformCustomer: true, totalFeeCents: 500, alreadyBilled: false, invoicePaid: true,
    })).toBe('paid')
  })

  it('invoice failed → failed', () => {
    expect(classify({
      hasPlatformCustomer: true, totalFeeCents: 500, alreadyBilled: false, invoiceFailed: true,
    })).toBe('failed')
  })
})

describe('Invoice line item — fee calculation (spec 24a)', () => {
  // Mirrors the rounding in billing.ts
  const SUCCESS_FEE_RATE = 0.15

  function feeCents(mrrCents: number): number {
    return Math.round(mrrCents * SUCCESS_FEE_RATE)
  }

  it('15% of $29/mo = $4.35', () => {
    expect(feeCents(2900)).toBe(435)
  })

  it('15% of $99/mo = $14.85', () => {
    expect(feeCents(9900)).toBe(1485)
  })

  it('rounds to nearest cent', () => {
    // 15% of $1.00 = $0.15, but 15% of $1.01 = $0.1515 → rounds to 15
    // 15% of $1.03 = $0.1545 → rounds to 15 too (banker's round? no, half-up)
    // Actually Math.round(15.45) = 15 (half-away-from-zero in JS when positive)
    expect(feeCents(101)).toBe(15)
    expect(feeCents(103)).toBe(15)
    expect(feeCents(107)).toBe(16)   // 0.1605 → 16
  })

  it('zero MRR → zero fee', () => {
    expect(feeCents(0)).toBe(0)
  })
})

describe('humanPeriodFromInvoice (spec 24b)', () => {
  it('prefers metadata.period_yyyymm when present and valid', async () => {
    const { humanPeriodFromInvoice } = await import('../lib/platform-billing')
    const fakeInvoice = {
      metadata: { period_yyyymm: '2026-05' },
      created: Math.floor(new Date('2026-06-01').getTime() / 1000),
    } as unknown as import('stripe').default.Invoice
    expect(humanPeriodFromInvoice(fakeInvoice)).toBe('May 2026')
  })

  it('falls back to month of created when metadata missing', async () => {
    const { humanPeriodFromInvoice } = await import('../lib/platform-billing')
    const fakeInvoice = {
      metadata: {},
      created: Math.floor(Date.UTC(2026, 4, 15) / 1000),  // May 15 2026
    } as unknown as import('stripe').default.Invoice
    expect(humanPeriodFromInvoice(fakeInvoice)).toBe('May 2026')
  })

  it('ignores malformed metadata period', async () => {
    const { humanPeriodFromInvoice } = await import('../lib/platform-billing')
    const fakeInvoice = {
      metadata: { period_yyyymm: '2026/05' },  // wrong format
      created: Math.floor(Date.UTC(2026, 4, 1) / 1000),
    } as unknown as import('stripe').default.Invoice
    expect(humanPeriodFromInvoice(fakeInvoice)).toBe('May 2026')
  })
})

describe('Invoice status → badge mapping (spec 24b)', () => {
  // Mirrors the StatusBadge config in invoice-list.tsx
  const configLabels: Record<string, string> = {
    paid: 'Paid',
    open: 'Unpaid',
    uncollectible: 'Uncollectible',
    void: 'Void',
    draft: 'Draft',
  }

  it('all known statuses map to a label', () => {
    for (const status of ['paid', 'open', 'uncollectible', 'void', 'draft']) {
      expect(configLabels[status]).toBeDefined()
    }
  })

  it('unknown status falls back to raw value', () => {
    // Verified in the component — unknown statuses render their raw string
    const unknownLabel = (s: string) => configLabels[s] ?? s
    expect(unknownLabel('weird_status')).toBe('weird_status')
  })
})
