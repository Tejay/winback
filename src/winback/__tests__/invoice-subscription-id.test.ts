/**
 * Spec 57 — getInvoiceSubscriptionId
 *
 * Stripe API ≥ 2024-09-30 removed the top-level `invoice.subscription`
 * field; the subscription reference moved to
 * `invoice.parent.subscription_details.subscription`. The helper reads
 * the new path with a fallback to the legacy field for older replayed
 * events / older webhook endpoint API versions.
 */

import { describe, it, expect } from 'vitest'
import { getInvoiceSubscriptionId } from '../lib/stripe'

describe('Spec 57 — getInvoiceSubscriptionId', () => {
  it('(a) new shape — parent.subscription_details.subscription as string', () => {
    const invoice = {
      id: 'in_x',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_abc123' },
      },
    }
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_abc123')
  })

  it('(a-expanded) new shape — parent.subscription_details.subscription as expanded object', () => {
    const invoice = {
      id: 'in_x',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: { id: 'sub_abc123', status: 'active' } },
      },
    }
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_abc123')
  })

  it('(b) legacy shape — top-level invoice.subscription as string', () => {
    const invoice = { id: 'in_x', subscription: 'sub_legacy_456' }
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_legacy_456')
  })

  it('(c) legacy shape — top-level invoice.subscription as expanded object', () => {
    const invoice = {
      id: 'in_x',
      subscription: { id: 'sub_legacy_456', status: 'active' },
    }
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_legacy_456')
  })

  it('(d) neither set — returns null (one-time invoice or malformed)', () => {
    expect(getInvoiceSubscriptionId({ id: 'in_x' })).toBeNull()
    expect(getInvoiceSubscriptionId({ id: 'in_x', parent: { type: 'manual' } })).toBeNull()
    expect(getInvoiceSubscriptionId({
      id: 'in_x',
      parent: { type: 'subscription_details', subscription_details: {} },
    })).toBeNull()
  })

  it('(d-types) non-object inputs return null safely', () => {
    expect(getInvoiceSubscriptionId(null)).toBeNull()
    expect(getInvoiceSubscriptionId(undefined)).toBeNull()
    expect(getInvoiceSubscriptionId('not an invoice')).toBeNull()
    expect(getInvoiceSubscriptionId(42)).toBeNull()
  })

  it('precedence — new path wins when both are set', () => {
    // Defensive: if Stripe ever sends both fields (e.g. backfilled
    // older events), the new path should win because that's where the
    // current API stores the authoritative value.
    const invoice = {
      id: 'in_x',
      subscription: 'sub_legacy_old',
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_new_correct' },
      },
    }
    expect(getInvoiceSubscriptionId(invoice)).toBe('sub_new_correct')
  })
})
