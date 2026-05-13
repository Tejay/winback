import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Spec 65 Phase 3 — unit tests for the matcher / sanity-check / email
 * generation helpers. LLM calls are mocked. The cron-level eligibility
 * logic is verified manually on dev (heavy DB mocking has poor signal-
 * to-noise for short-lived integration code).
 */

const mockCreate = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import {
  deriveTriggerNeedConfidence,
  checkImprovementMatch,
  findBestMatch,
  sanityCheckEmail,
  generateImprovementEmail,
  MATCH_CONFIDENCE_THRESHOLD,
  type ImprovementForMatcher,
} from '../lib/improvement-match'

beforeEach(() => {
  mockCreate.mockReset()
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
})

function mockResp(text: string) {
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text }] })
}

const baseClassification = {
  tier: 1 as const,
  tierReason: '',
  confidence: 0.85,
  triggerKeyword: '',
  triggerNeed: 'Wanted bulk CSV import for large customer base',
  cancellationReason: 'no bulk import',
  cancellationCategory: 'Feature',
  winBackSubject: '',
  winBackBody: '',
  firstMessage: null,
  handoff: false,
  handoffReasoning: '',
  recoveryLikelihood: 'medium' as const,
  suppress: false,
}

const baseImprovement: ImprovementForMatcher = {
  id:          'imp_1',
  title:       'Shipped bulk CSV import',
  description: 'Up to 100K rows. Streams to S3.',
  dateShipped: '2026-05-10',
}

describe('deriveTriggerNeedConfidence', () => {
  it('returns "high" for concrete trigger need + high confidence + categorised', () => {
    expect(deriveTriggerNeedConfidence(baseClassification)).toBe('high')
  })

  it('returns "low" when triggerNeed is null', () => {
    expect(deriveTriggerNeedConfidence({ ...baseClassification, triggerNeed: null })).toBe('low')
  })

  it('returns "low" when triggerNeed is < 10 chars', () => {
    expect(deriveTriggerNeedConfidence({ ...baseClassification, triggerNeed: 'short' })).toBe('low')
  })

  it('returns "low" when classifier confidence is < 0.7', () => {
    expect(deriveTriggerNeedConfidence({ ...baseClassification, confidence: 0.5 })).toBe('low')
  })

  it('returns "low" when cancellationCategory is "Other"', () => {
    expect(deriveTriggerNeedConfidence({ ...baseClassification, cancellationCategory: 'Other' })).toBe('low')
  })
})

describe('checkImprovementMatch', () => {
  it('returns matches=true with high confidence on a clear match', async () => {
    mockResp('{"matches": true, "confidence": 0.92, "reasoning": "directly addresses"}')
    const r = await checkImprovementMatch('Needs bulk CSV import', baseImprovement)
    expect(r.matches).toBe(true)
    expect(r.confidence).toBeGreaterThan(0.7)
  })

  it('returns matches=false on a clear non-match', async () => {
    mockResp('{"matches": false, "confidence": 0.1, "reasoning": "different feature"}')
    const r = await checkImprovementMatch('Wants Slack notifications', baseImprovement)
    expect(r.matches).toBe(false)
  })

  it('fails closed on LLM error (returns matches=false)', async () => {
    mockCreate.mockRejectedValue(new Error('API down'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await checkImprovementMatch('Wants CSV', baseImprovement)
    expect(r.matches).toBe(false)
    consoleSpy.mockRestore()
  })

  it('fails closed on parse failure', async () => {
    mockResp('not valid json')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await checkImprovementMatch('Wants CSV', baseImprovement)
    expect(r.matches).toBe(false)
    consoleSpy.mockRestore()
  })

  it('handles markdown code fences in LLM response', async () => {
    mockResp('```json\n{"matches": true, "confidence": 0.85, "reasoning": "fine"}\n```')
    const r = await checkImprovementMatch('Wants CSV', baseImprovement)
    expect(r.matches).toBe(true)
  })
})

describe('findBestMatch', () => {
  const a: ImprovementForMatcher = { id: 'a', title: 'A', description: 'a desc', dateShipped: '2026-05-01' }
  const b: ImprovementForMatcher = { id: 'b', title: 'B', description: 'b desc', dateShipped: '2026-05-02' }
  const c: ImprovementForMatcher = { id: 'c', title: 'C', description: 'c desc', dateShipped: '2026-05-03' }

  it('returns null when improvements list is empty', async () => {
    expect(await findBestMatch('want', [])).toBeNull()
  })

  it('returns null when triggerNeed is empty', async () => {
    expect(await findBestMatch('', [a])).toBeNull()
  })

  it('returns null when no improvement crosses the threshold', async () => {
    mockResp('{"matches": false, "confidence": 0.4, "reasoning": "no"}')
    const r = await findBestMatch('want X', [a])
    expect(r).toBeNull()
  })

  it('picks the highest-confidence match across multiple', async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"matches": true, "confidence": 0.75, "reasoning": ""}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"matches": true, "confidence": 0.92, "reasoning": ""}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"matches": true, "confidence": 0.80, "reasoning": ""}' }] })
    const r = await findBestMatch('want X', [a, b, c])
    expect(r?.improvement.id).toBe('b')
    expect(r?.match.confidence).toBe(0.92)
  })

  it('ignores matches below the threshold even if they are the only ones', async () => {
    mockCreate
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"matches": true, "confidence": 0.55, "reasoning": ""}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"matches": true, "confidence": 0.65, "reasoning": ""}' }] })
    const r = await findBestMatch('want X', [a, b])
    expect(r).toBeNull()
  })

  it('threshold constant is 0.7 (regression — change spec if this changes)', () => {
    expect(MATCH_CONFIDENCE_THRESHOLD).toBe(0.7)
  })
})

describe('sanityCheckEmail', () => {
  const draft = { subject: 'CSV import is here', body: 'Hi — we shipped bulk CSV import...' }

  it('passes when email mentions the improvement and matches the reason', async () => {
    mockResp('{"pass": true, "reason": ""}')
    const r = await sanityCheckEmail({
      triggerNeed: 'Wants CSV import',
      improvement: baseImprovement,
      email: draft,
    })
    expect(r.pass).toBe(true)
  })

  it('fails when email is fundamentally off-topic', async () => {
    mockResp('{"pass": false, "reason": "off-topic"}')
    const r = await sanityCheckEmail({
      triggerNeed: 'Wants CSV import',
      improvement: baseImprovement,
      email: { subject: 'Slack alerts', body: 'We shipped Slack...' },
    })
    expect(r.pass).toBe(false)
  })

  it('fails closed on LLM error', async () => {
    mockCreate.mockRejectedValue(new Error('API down'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await sanityCheckEmail({
      triggerNeed: 'x',
      improvement: baseImprovement,
      email: draft,
    })
    expect(r.pass).toBe(false)
    consoleSpy.mockRestore()
  })

  it('fails closed on parse failure', async () => {
    mockResp('garbage')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await sanityCheckEmail({
      triggerNeed: 'x',
      improvement: baseImprovement,
      email: draft,
    })
    expect(r.pass).toBe(false)
    consoleSpy.mockRestore()
  })
})

describe('generateImprovementEmail', () => {
  it('returns subject+body on valid LLM JSON', async () => {
    mockResp('{"subject":"CSV is here","body":"Hi Sarah, we just shipped bulk CSV import."}')
    const r = await generateImprovementEmail({
      improvement:    baseImprovement,
      triggerNeed:    'Wants CSV import',
      subscriberName: 'Sarah Chen',
      founderName:    'Alex',
    })
    expect(r?.subject).toBe('CSV is here')
  })

  it('returns null on LLM failure', async () => {
    mockCreate.mockRejectedValue(new Error('API down'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await generateImprovementEmail({
      improvement: baseImprovement,
      triggerNeed: 'x',
      subscriberName: 'A',
      founderName: 'B',
    })
    expect(r).toBeNull()
    consoleSpy.mockRestore()
  })

  it('passes the age (months ago) into the prompt for age-aware tone', async () => {
    // The improvement is dated 2026-05-10. We can't assert the LLM's
    // behaviour, but we can verify the prompt includes the age string.
    mockResp('{"subject":"S","body":"B"}')
    await generateImprovementEmail({
      improvement: { ...baseImprovement, dateShipped: '2025-11-10' },  // ~6 months ago
      triggerNeed: 'x',
      subscriberName: null,
      founderName:    'Alex',
    })
    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].content).toMatch(/months ago/)
  })
})
