/**
 * Spec 34 — declineCodeToCopy: pure rule-based mapping tests.
 *
 * No mocks, no DB — the helper takes a string (or null) and returns a
 * fixed shape. Tests assert each bucket produces the right reason +
 * action lines, plus the fallback for unknowns.
 */
import { describe, it, expect } from 'vitest'
import { declineCodeToCopy } from '../lib/decline-codes'

describe('declineCodeToCopy (Spec 34)', () => {
  it('expired_card → bucket "expired" with "expired" / "update" copy', () => {
    const c = declineCodeToCopy('expired_card')
    expect(c.bucket).toBe('expired')
    expect(c.reason.toLowerCase()).toContain('expired')
    expect(c.action.toLowerCase()).toContain('update')
  })

  it('insufficient_funds → bucket "insufficient_funds" with "different card" suggestion', () => {
    const c = declineCodeToCopy('insufficient_funds')
    expect(c.bucket).toBe('insufficient_funds')
    expect(c.reason.toLowerCase()).toContain('insufficient funds')
    expect(c.action.toLowerCase()).toContain('different card')
  })

  it('do_not_honor / card_declined / generic_decline → bucket "bank_declined" with "call the number" advice', () => {
    for (const code of ['do_not_honor', 'card_declined', 'generic_decline']) {
      const c = declineCodeToCopy(code)
      expect(c.bucket).toBe('bank_declined')
      expect(c.action.toLowerCase()).toContain('call the number')
    }
  })

  it('lost_card / stolen_card / card_not_supported → bucket "card_flagged" with different-card advice', () => {
    for (const code of ['lost_card', 'stolen_card', 'card_not_supported']) {
      const c = declineCodeToCopy(code)
      expect(c.bucket).toBe('card_flagged')
      expect(c.action.toLowerCase()).toContain('different card')
    }
  })

  it('card_velocity_exceeded / fraudulent / pickup_card → bucket "fraud_review" with "call the number" advice', () => {
    for (const code of ['card_velocity_exceeded', 'fraudulent', 'pickup_card']) {
      const c = declineCodeToCopy(code)
      expect(c.bucket).toBe('fraud_review')
      expect(c.action.toLowerCase()).toContain('call the number')
    }
  })

  it('processing_error / try_again_later → bucket "temporary" with suppressUpdateCta=true and "no action needed" copy', () => {
    for (const code of ['processing_error', 'try_again_later']) {
      const c = declineCodeToCopy(code)
      expect(c.bucket).toBe('temporary')
      expect(c.suppressUpdateCta).toBe(true)
      expect(c.action.toLowerCase()).toContain('no action needed')
    }
  })

  it('null / undefined / empty → fallback bucket with generic copy + no suppression', () => {
    for (const v of [null, undefined, '']) {
      const c = declineCodeToCopy(v)
      expect(c.bucket).toBe('fallback')
      expect(c.reason).toMatch(/didn't go through|usually happens/i)
      expect(c.suppressUpdateCta).toBeFalsy()
    }
  })

  it('unknown decline code (e.g. "incorrect_zip") → fallback bucket', () => {
    const c = declineCodeToCopy('incorrect_zip')
    expect(c.bucket).toBe('fallback')
    expect(c.suppressUpdateCta).toBeFalsy()
  })
})
