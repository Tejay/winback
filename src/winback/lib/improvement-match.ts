import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { ClassificationResult, SubscriberSignals } from './types'

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
const MATCH_SYSTEM_PROMPT = `You decide whether a single shipped product improvement addresses a single cancelled subscriber's stated reason for leaving.

Be strict. False positives (saying "matches" when it doesn't) cause us to send the subscriber a wrong email — that burns their trust permanently. False negatives (saying "doesn't match" when it does) just delay a possible recovery — recoverable.

Return ONLY a JSON object: {"matches": true|false, "confidence": <number 0..1>, "reasoning": "<one short sentence>"}. No preamble, no markdown.

Use confidence aggressively: only set matches=true with confidence ≥ 0.7 if the improvement clearly and directly addresses the subscriber's stated need. Synonyms and feature-equivalent capabilities count; tangential mentions, partial overlaps, or "maybe" connections do not.`

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
const GENERATE_SYSTEM_PROMPT = `You write a single short, concrete re-engagement email to a previously-cancelled subscriber.

The product just shipped (or recently shipped) something that addresses their stated reason for leaving. Your job is to tell them about it specifically — not vaguely.

RULES:
- Reference what shipped using the language from the improvement title and description. Don't say "we made improvements" — say what shipped.
- Reference what they wanted, briefly, so they remember the context.
- Keep it short — 3-5 sentences max.
- End with a single low-pressure call to action: a question like "Want to give it a try?" or "Worth another look?". Not a hard sell.
- Sign with the founder's name.
- Do NOT mention discounts.
- Plain text only — no markdown, no HTML, no signatures beyond the founder name.
- Do NOT include the unsubscribe / reactivation footer — those are appended automatically.

TONE BY AGE:
- If the improvement shipped recently (< 3 months ago): use "we just shipped X" or "I shipped X last week".
- If the improvement shipped 3+ months ago: use softer framing like "you may have noticed we shipped X" or "we rolled out X a few months back". Avoid implying it's brand new — they may have already seen it.

Return ONLY valid JSON: {"subject": "...", "body": "..."}. No preamble, no markdown.`

const GeneratedEmailSchema = z.object({
  subject: z.string().min(1).max(120),
  body:    z.string().min(1).max(2000),
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
const SANITY_SYSTEM_PROMPT = `You're a quality gate for re-engagement emails. You receive:
- A cancelled subscriber's stated reason for leaving
- A product improvement we just matched to it
- The drafted email we're about to send

Decide: does the drafted email accurately reference the improvement AND address the subscriber's reason? Return JSON: {"pass": true|false, "reason": "<short>"}.

Pass if: the email mentions the actual improvement (by feature name or specific capability), and the connection to the subscriber's reason is reasonable.

Fail if: the email mentions a feature NOT in the improvement; the email is generic and doesn't reference the specific improvement at all; the email makes false claims (e.g., implies the feature shipped longer ago than it did, or claims a feature that doesn't appear in the improvement); the email is fundamentally about a different topic than the subscriber's reason.

Be strict only on factual mismatches and topic drift. Stylistic preferences are not failures.`

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

// Re-exports for tests
export { MATCH_SYSTEM_PROMPT, GENERATE_SYSTEM_PROMPT, SANITY_SYSTEM_PROMPT }

// Type re-export to keep the module self-contained.
export type { ClassificationResult, SubscriberSignals }
