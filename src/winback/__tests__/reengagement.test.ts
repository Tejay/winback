import { describe, it, expect } from 'vitest'
import { hasSignalForLLM, classifySilentChurn, BACKFILL_EMAIL_CUTOFF_DAYS } from '../lib/backfill'

describe('hasSignalForLLM', () => {
  it('returns true when stripeComment is present', () => {
    expect(hasSignalForLLM({ stripeEnum: null, stripeComment: 'Too expensive for my budget' })).toBe(true)
  })

  it('returns true when stripeEnum is present', () => {
    expect(hasSignalForLLM({ stripeEnum: 'too_expensive', stripeComment: null })).toBe(true)
  })

  it('returns true when both are present', () => {
    expect(hasSignalForLLM({ stripeEnum: 'missing_features', stripeComment: 'Need Zapier' })).toBe(true)
  })

  it('returns false for silent churn (no enum, no comment)', () => {
    expect(hasSignalForLLM({ stripeEnum: null, stripeComment: null })).toBe(false)
  })

  it('returns false for empty strings', () => {
    expect(hasSignalForLLM({ stripeEnum: '', stripeComment: '' })).toBe(false)
  })
})

describe('classifySilentChurn', () => {
  it('returns tier 3 with Other category', () => {
    const result = classifySilentChurn()
    expect(result.tier).toBe(3)
    expect(result.cancellationCategory).toBe('Other')
    expect(result.cancellationReason).toBe('No reason given')
  })

  it('returns low confidence', () => {
    const result = classifySilentChurn()
    expect(result.confidence).toBeLessThanOrEqual(0.5)
  })

  it('does not suppress (eligible for changelog triggers)', () => {
    const result = classifySilentChurn()
    expect(result.suppress).toBe(false)
  })

  it('returns null firstMessage (no email to send)', () => {
    const result = classifySilentChurn()
    expect(result.firstMessage).toBeNull()
  })

  it('returns null triggerKeyword (nothing to match on)', () => {
    const result = classifySilentChurn()
    expect(result.triggerKeyword).toBeNull()
  })
})

describe('BACKFILL_EMAIL_CUTOFF_DAYS', () => {
  it('is 7 days', () => {
    expect(BACKFILL_EMAIL_CUTOFF_DAYS).toBe(7)
  })
})
