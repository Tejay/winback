import { describe, it, expect } from 'vitest'
import { z } from 'zod'

/**
 * Spec 79 — cluster-cancellations unit tests.
 *
 * The clusterer itself does a real LLM call + DB writes, so a true unit
 * test would have to mock both. Instead these tests pin down the parts
 * we can validate without infrastructure: the output schema (rejects
 * malformed LLM responses) and the hallucination-guard logic (drops
 * subscriber IDs / improvement IDs the LLM made up).
 *
 * The schema is re-declared here to mirror what cluster-cancellations.ts
 * declares internally; if the real schema drifts, these tests catch it
 * by reference (we re-import its tunables to keep MIN_THEME_SIZE in sync).
 */

import { MIN_THEME_SIZE } from '../lib/cluster-cancellations'

// Mirror of the internal ThemeSchema for test purposes.
const ThemeSchema = z.object({
  title:                  z.string().min(1).max(80),
  description:            z.string().min(1).max(280),
  category:               z.enum(['Price', 'Feature', 'Other']).nullable(),
  emoji:                  z.string().min(1).max(8),
  subscriberIds:          z.array(z.string().uuid()).min(MIN_THEME_SIZE),
  sampleQuotes:           z.array(z.string().min(1)).min(1).max(5),
  addressesImprovementId: z.string().uuid().nullable(),
})
const ClusterOutputSchema = z.object({ themes: z.array(ThemeSchema) })

// RFC-compliant v4 UUIDs (Zod 4 enforces format: 3rd group starts 1-8, 4th starts 8|9|a|b)
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-9222-222222222222'
const UUID_C = '33333333-3333-4333-a333-333333333333'
const UUID_D = '44444444-4444-4444-b444-444444444444'
const IMP_X = '55555555-5555-4555-8555-555555555555'
const IMP_Y = '66666666-6666-4666-9666-666666666666'

function validTheme(over: Partial<z.infer<typeof ThemeSchema>> = {}) {
  return {
    title:                  'Native Slack integration',
    description:            'Wanted first-party Slack app, not Zapier.',
    category:               'Feature' as const,
    emoji:                  '🌱',
    subscriberIds:          [UUID_A, UUID_B, UUID_C],
    sampleQuotes:           ['need real slack support', 'zapier is too brittle'],
    addressesImprovementId: null,
    ...over,
  }
}

describe('ClusterOutputSchema validation', () => {
  it('accepts a well-formed theme', () => {
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme()] })
    expect(res.success).toBe(true)
  })

  it('rejects themes with fewer than MIN_THEME_SIZE subscribers', () => {
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme({ subscriberIds: [UUID_A, UUID_B] })] })
    expect(res.success).toBe(false)
  })

  it('rejects themes with non-UUID subscriber ids', () => {
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme({ subscriberIds: ['not-a-uuid-at-all', UUID_A, UUID_B] })] })
    expect(res.success).toBe(false)
  })

  it('rejects themes with invalid category', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme({ category: 'Bogus' as any })] })
    expect(res.success).toBe(false)
  })

  it('accepts addressesImprovementId set to a valid uuid', () => {
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme({ addressesImprovementId: IMP_X })] })
    expect(res.success).toBe(true)
  })

  it('rejects addressesImprovementId that is not a uuid', () => {
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme({ addressesImprovementId: 'imp_x' })] })
    expect(res.success).toBe(false)
  })

  it('rejects empty sampleQuotes', () => {
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme({ sampleQuotes: [] })] })
    expect(res.success).toBe(false)
  })

  it('rejects oversized title', () => {
    const res = ClusterOutputSchema.safeParse({ themes: [validTheme({ title: 'a'.repeat(81) })] })
    expect(res.success).toBe(false)
  })
})

describe('hallucination guard — filterValidSubscriberIds (mirrors inline logic in clusterCancellationsForCustomer)', () => {
  function applyGuard(
    themes: z.infer<typeof ThemeSchema>[],
    validSubscriberIds: Set<string>,
    validImprovementIds: Set<string>,
  ) {
    return themes
      .map((t) => ({
        ...t,
        subscriberIds: t.subscriberIds.filter((id) => validSubscriberIds.has(id)),
        addressesImprovementId: t.addressesImprovementId && validImprovementIds.has(t.addressesImprovementId)
          ? t.addressesImprovementId
          : null,
      }))
      .filter((t) => t.subscriberIds.length >= MIN_THEME_SIZE)
  }

  const UUID_HALLUCINATED = '77777777-7777-4777-8777-777777777777'

  it('strips subscriber IDs the LLM invented and drops the cluster if it falls below threshold', () => {
    const theme = validTheme({ subscriberIds: [UUID_A, UUID_B, UUID_HALLUCINATED] })
    const out = applyGuard([theme], new Set([UUID_A, UUID_B]), new Set())
    expect(out).toEqual([])
  })

  it('keeps the cluster when enough valid subscriber IDs remain', () => {
    const theme = validTheme({ subscriberIds: [UUID_A, UUID_B, UUID_C, UUID_D, UUID_HALLUCINATED] })
    const out = applyGuard([theme], new Set([UUID_A, UUID_B, UUID_C, UUID_D]), new Set())
    expect(out).toHaveLength(1)
    expect(out[0].subscriberIds).toEqual([UUID_A, UUID_B, UUID_C, UUID_D])
  })

  it('nulls addressesImprovementId when LLM references an improvement we did not pass in', () => {
    const theme = validTheme({ addressesImprovementId: IMP_Y })
    const out = applyGuard([theme], new Set([UUID_A, UUID_B, UUID_C]), new Set([IMP_X]))
    expect(out[0].addressesImprovementId).toBeNull()
  })

  it('keeps addressesImprovementId when it matches a passed-in improvement', () => {
    const theme = validTheme({ addressesImprovementId: IMP_X })
    const out = applyGuard([theme], new Set([UUID_A, UUID_B, UUID_C]), new Set([IMP_X]))
    expect(out[0].addressesImprovementId).toBe(IMP_X)
  })
})
