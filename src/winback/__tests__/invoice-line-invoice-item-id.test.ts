/**
 * Spec 61 — getInvoiceLineInvoiceItemId
 *
 * Stripe API ≥ 2024-09-30 moved `line.invoice_item` to
 * `line.parent.invoice_item_details.invoice_item`. Helper reads the
 * new path with fallback to the legacy field. Used by
 * refundPerformanceFee to find the right invoice line to credit-note.
 */

import { describe, it, expect } from 'vitest'
import { getInvoiceLineInvoiceItemId } from '../lib/stripe'

describe('Spec 61 — getInvoiceLineInvoiceItemId', () => {
  it('(a) new shape — parent.invoice_item_details.invoice_item', () => {
    const line = {
      id: 'il_x',
      parent: {
        type: 'invoice_item_details',
        invoice_item_details: { invoice_item: 'ii_AAA' },
      },
    }
    expect(getInvoiceLineInvoiceItemId(line)).toBe('ii_AAA')
  })

  it('(b) legacy shape — top-level line.invoice_item', () => {
    const line = { id: 'il_x', invoice_item: 'ii_LEGACY' }
    expect(getInvoiceLineInvoiceItemId(line)).toBe('ii_LEGACY')
  })

  it('(c) neither set — returns null', () => {
    // Subscription line in the new API shape — has no invoice_item.
    expect(getInvoiceLineInvoiceItemId({
      id: 'il_x',
      parent: { type: 'subscription_item_details', subscription_item_details: {} },
    })).toBeNull()
    expect(getInvoiceLineInvoiceItemId({ id: 'il_x' })).toBeNull()
  })

  it('(d) non-object inputs return null safely', () => {
    expect(getInvoiceLineInvoiceItemId(null)).toBeNull()
    expect(getInvoiceLineInvoiceItemId(undefined)).toBeNull()
    expect(getInvoiceLineInvoiceItemId('not a line')).toBeNull()
    expect(getInvoiceLineInvoiceItemId(42)).toBeNull()
  })

  it('precedence — new path wins when both are present', () => {
    const line = {
      id: 'il_x',
      invoice_item: 'ii_LEGACY_OLD',
      parent: {
        type: 'invoice_item_details',
        invoice_item_details: { invoice_item: 'ii_NEW_CORRECT' },
      },
    }
    expect(getInvoiceLineInvoiceItemId(line)).toBe('ii_NEW_CORRECT')
  })
})
