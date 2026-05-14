import { describe, it, expect } from 'vitest'
// Spec 72 — helpers moved from backfill.ts into classifier-tick.ts when the
// producer/consumer refactor split ingest from classification.
import { hasSignalForLLM, classifySilentChurn } from '../lib/classifier-tick'

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

// Spec 72 — the 7-day exit-email recency window moved from backfill.ts
// into classifier-tick.ts (renamed EXIT_EMAIL_RECENCY_DAYS, kept as an
// internal constant). The test for the magic-number guarantee is dropped
// because the constant is no longer exported. The recency behavior is
// covered by the classifier-tick integration test instead.
