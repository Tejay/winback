import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { ClassificationResult, SubscriberSignals } from './types'
// Prompt source of truth: /prompts/*.md
// Regenerate prompts.generated.ts with `npm run prompts:build`.
import {
  MATCH_SYSTEM_PROMPT,
  GENERATE_SYSTEM_PROMPT,
  SANITY_SYSTEM_PROMPT,
  GENERATE_PROMOTION_SYSTEM_PROMPT,
  SANITY_PROMO_SYSTEM_PROMPT,
} from './prompts.generated'

/**
 * Spec 65 — improvement matcher + email generator + pre-send sanity check.
 *
 * Operates on the wb_improvements per-entry model: ONE subscriber's
 * triggerNeed is compared against EACH active improvement, and we pick
 * the single best match (highest confidence) above a threshold.
 */

// --------------------------------------------------------------------------
// Anthropic client (same fallback pattern used elsewhere)
// --------------------------------------------------------------------------
function getClient(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || !key.startsWith('sk-')) {
    try {
      const fs = require('fs')
      const path = require('path')
      const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8')
      const m = envFile.match(/^ANTHROPIC_API_KEY="?([^"\n]+)"?$/m)
      if (m?.[1]) return new Anthropic({ apiKey: m[1] })
    } catch {}
    throw new Error('ANTHROPIC_API_KEY is not set')
  }
  return new Anthropic({ apiKey: key })
}

// --------------------------------------------------------------------------
// Trigger-need confidence gate
// --------------------------------------------------------------------------
/**
 * Derive a coarse high/low bucket from classifier output. Subscribers with
 * 'low' confidence are never considered for matching — they're effectively
 * silent churn, which removes the biggest single source of false-positive
 * re-engagement emails.
 *
 * Rules: triggerNeed must be present and at least 10 characters; classifier
 * confidence ≥ 0.7; cancellationCategory must not be 'Other' (the most
 * ambiguous bucket).
 */
export function deriveTriggerNeedConfidence(c: ClassificationResult): 'high' | 'low' {
  if (!c.triggerNeed) return 'low'
  if (c.triggerNeed.trim().length < 10) return 'low'
  if (typeof c.confidence === 'number' && c.confidence < 0.7) return 'low'
  if (c.cancellationCategory === 'Other') return 'low'
  return 'high'
}

// --------------------------------------------------------------------------
// Improvement input shape (decoupled from the Drizzle row)
// --------------------------------------------------------------------------
export interface ImprovementForMatcher {
  id:           string
  title:        string
  description:  string
  dateShipped:  string  // YYYY-MM-DD
}

// --------------------------------------------------------------------------
// Match check — one subscriber's triggerNeed against one improvement
// --------------------------------------------------------------------------
const MatchSchema = z.object({
  matches:    z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning:  z.string().default(''),
})

export type MatchResult = z.infer<typeof MatchSchema>

export async function checkImprovementMatch(
  triggerNeed: string,
  improvement: ImprovementForMatcher,
): Promise<MatchResult> {
  const userPrompt = `SUBSCRIBER'S STATED REASON FOR LEAVING:
${triggerNeed}

IMPROVEMENT SHIPPED:
Title: ${improvement.title}
Description: ${improvement.description}
Shipped: ${improvement.dateShipped}

Does this improvement clearly address the subscriber's reason? Return JSON.`

  try {
    const response = await getClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  200,
      temperature: 0,
      system:      MATCH_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    })
    let raw = response.content[0].type === 'text' ? response.content[0].text : ''
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed = JSON.parse(raw)
    const result = MatchSchema.safeParse(parsed)
    if (!result.success) return { matches: false, confidence: 0, reasoning: 'parse_failed' }
    return result.data
  } catch (err) {
    console.error('[improvement-match] checkImprovementMatch failed:', err)
    return { matches: false, confidence: 0, reasoning: 'llm_error' }
  }
}

// --------------------------------------------------------------------------
// findBestMatch — across all active improvements, pick the single highest-
// confidence match for one subscriber. Returns null if nothing crosses
// the threshold.
// --------------------------------------------------------------------------
export const MATCH_CONFIDENCE_THRESHOLD = 0.7

export async function findBestMatch(
  triggerNeed: string,
  improvements: ImprovementForMatcher[],
): Promise<{ improvement: ImprovementForMatcher; match: MatchResult } | null> {
  if (improvements.length === 0) return null
  if (!triggerNeed || triggerNeed.trim().length === 0) return null

  let best: { improvement: ImprovementForMatcher; match: MatchResult } | null = null
  for (const imp of improvements) {
    const m = await checkImprovementMatch(triggerNeed, imp)
    if (!m.matches) continue
    if (m.confidence < MATCH_CONFIDENCE_THRESHOLD) continue
    if (!best || m.confidence > best.match.confidence) {
      best = { improvement: imp, match: m }
    }
  }
  return best
}

// --------------------------------------------------------------------------
// Email generation — age-aware tone
// --------------------------------------------------------------------------
// Spec 72 — body targets 250 chars (prompt's hard rule) with a 500-char
// ceiling (2× target) to absorb LLM imprecision. Bodies above 500 fail
// validation and generateImprovementEmail returns null (caller falls
// back gracefully).
const GeneratedEmailSchema = z.object({
  subject: z.string().min(1).max(120),
  body:    z.string().min(1).max(500, 'Body exceeds 500-character ceiling (target 250)'),
})

export async function generateImprovementEmail(params: {
  improvement:     ImprovementForMatcher
  triggerNeed:     string
  subscriberName:  string | null
  founderName:     string
}): Promise<{ subject: string; body: string } | null> {
  const { improvement, triggerNeed, subscriberName, founderName } = params
  const firstName = subscriberName?.split(' ')[0] ?? 'there'

  // Age in months (rounded down)
  const shipped = new Date(improvement.dateShipped + 'T00:00:00Z')
  const monthsAgo = Math.max(0, Math.floor((Date.now() - shipped.getTime()) / (30 * 24 * 60 * 60 * 1000)))

  const userPrompt = `Subscriber first name: ${firstName}
Founder first name: ${founderName}

What this subscriber wanted when they cancelled:
${triggerNeed}

What we shipped:
Title: ${improvement.title}
Description: ${improvement.description}
Shipped: ${improvement.dateShipped} (${monthsAgo} months ago)

Write a short, concrete re-engagement email. Return JSON.`

  try {
    const response = await getClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  600,
      temperature: 0.3,
      system:      GENERATE_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    })
    let raw = response.content[0].type === 'text' ? response.content[0].text : ''
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed = JSON.parse(raw)
    const result = GeneratedEmailSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch (err) {
    console.error('[improvement-match] generateImprovementEmail failed:', err)
    return null
  }
}

// --------------------------------------------------------------------------
// Pre-send sanity check — does the drafted email actually correspond to
// the matched improvement + triggerNeed? Catches hallucination.
// --------------------------------------------------------------------------
const SanitySchema = z.object({
  pass:   z.boolean(),
  reason: z.string().default(''),
})

export type SanityResult = z.infer<typeof SanitySchema>

export async function sanityCheckEmail(params: {
  triggerNeed: string
  improvement: ImprovementForMatcher
  email:       { subject: string; body: string }
}): Promise<SanityResult> {
  const userPrompt = `SUBSCRIBER'S REASON FOR LEAVING:
${params.triggerNeed}

IMPROVEMENT MATCHED:
Title: ${params.improvement.title}
Description: ${params.improvement.description}

DRAFTED EMAIL:
Subject: ${params.email.subject}
---
${params.email.body}
---

Does the email accurately reference the improvement AND address the subscriber's reason? Return JSON.`

  try {
    const response = await getClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  200,
      temperature: 0,
      system:      SANITY_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    })
    let raw = response.content[0].type === 'text' ? response.content[0].text : ''
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed = JSON.parse(raw)
    const result = SanitySchema.safeParse(parsed)
    if (!result.success) {
      // Conservative: fail closed if we can't parse the sanity check.
      return { pass: false, reason: 'sanity_parse_failed' }
    }
    return result.data
  } catch (err) {
    console.error('[improvement-match] sanityCheckEmail failed:', err)
    return { pass: false, reason: 'sanity_llm_error' }
  }
}

// --------------------------------------------------------------------------
// Spec 78 — Promotion-aware email generation
// --------------------------------------------------------------------------
/**
 * Separate prompt from GENERATE_SYSTEM_PROMPT. The discount ban there is
 * load-bearing for the listening-not-discounting positioning, so we keep
 * it intact and lift it only here for the explicit promotion branch.
 *
 * The merchant has already opted in (customers.promotionsEnabled = true)
 * and the matcher has confirmed Tier 1 + Price category, so there's no
 * "should we offer a discount?" — only "what's the most respectful way
 * to mention it once."
 */
const GeneratedPromotionEmailSchema = GeneratedEmailSchema

export interface PromotionForEmail {
  code:             string
  percentOff:       number | null
  amountOffCents:   number | null
  currency:         string | null
  duration:         'once' | 'repeating' | 'forever'
  durationInMonths: number | null
}

function formatPromoTerms(p: PromotionForEmail): string {
  const discount = p.percentOff !== null
    ? `${p.percentOff}% off`
    : p.amountOffCents !== null && p.currency
      ? `${(p.amountOffCents / 100).toFixed(2)} ${p.currency.toUpperCase()} off`
      : 'a discount'
  const duration = p.duration === 'forever'
    ? 'forever'
    : p.duration === 'once'
      ? 'once'
      : p.durationInMonths
        ? `${p.durationInMonths} months`
        : 'recurring'
  return `${discount}, ${duration}`
}

export async function generatePromotionEmail(params: {
  promotion:      PromotionForEmail
  triggerNeed:    string | null
  subscriberName: string | null
  founderName:    string
}): Promise<{ subject: string; body: string } | null> {
  const { promotion, triggerNeed, subscriberName, founderName } = params
  const firstName = subscriberName?.split(' ')[0] ?? 'there'

  const userPrompt = `Subscriber first name: ${firstName}
Founder first name: ${founderName}

What this subscriber said when they cancelled${triggerNeed ? '' : ' (nothing — they only marked Price as their cancellation category, no free-text reason)'}:
${triggerNeed ?? '(none)'}

Promotion to offer:
Code: ${promotion.code}
Terms: ${formatPromoTerms(promotion)}

Write a short, plain re-engagement email naming this discount once. Return JSON.`

  try {
    const response = await getClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  600,
      temperature: 0.3,
      system:      GENERATE_PROMOTION_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    })
    let raw = response.content[0].type === 'text' ? response.content[0].text : ''
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed = JSON.parse(raw)
    const result = GeneratedPromotionEmailSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch (err) {
    console.error('[improvement-match] generatePromotionEmail failed:', err)
    return null
  }
}

export async function sanityCheckPromotionEmail(params: {
  promotion: PromotionForEmail
  triggerNeed: string | null
  email: { subject: string; body: string }
}): Promise<SanityResult> {
  const userPrompt = `SUBSCRIBER'S REASON FOR LEAVING:
${params.triggerNeed ?? '(none — they only marked Price as their cancellation category)'}

PROMOTION OFFERED:
Code: ${params.promotion.code}
Terms: ${formatPromoTerms(params.promotion)}

DRAFTED EMAIL:
Subject: ${params.email.subject}
---
${params.email.body}
---

Does the email correctly mention this promotion's code + terms in a respectful single mention? Return JSON.`

  try {
    const response = await getClient().messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  200,
      temperature: 0,
      system:      SANITY_PROMO_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    })
    let raw = response.content[0].type === 'text' ? response.content[0].text : ''
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed = JSON.parse(raw)
    const result = SanitySchema.safeParse(parsed)
    if (!result.success) return { pass: false, reason: 'sanity_parse_failed' }
    return result.data
  } catch (err) {
    console.error('[improvement-match] sanityCheckPromotionEmail failed:', err)
    return { pass: false, reason: 'sanity_llm_error' }
  }
}

// Re-exports for tests
export {
  MATCH_SYSTEM_PROMPT,
  GENERATE_SYSTEM_PROMPT,
  SANITY_SYSTEM_PROMPT,
  GENERATE_PROMOTION_SYSTEM_PROMPT,
  SANITY_PROMO_SYSTEM_PROMPT,
}

// Type re-export to keep the module self-contained.
export type { ClassificationResult, SubscriberSignals }
