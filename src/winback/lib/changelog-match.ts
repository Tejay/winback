import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

/**
 * Changelog → subscriber matching + win-back email generation (spec 19).
 *
 * Two LLM-powered functions:
 *
 * 1. matchChangelogToSubscribers() — replaces the old SQL ILIKE substring filter.
 *    Reads each subscriber's stated need (or legacy keyword) and decides whether
 *    the changelog actually addresses it. Synonym/paraphrase aware.
 *
 * 2. generateWinBackEmail() — replaces the pre-written winBackBody templates.
 *    Generates a concrete, specific email at match time using the actual changelog
 *    text — so the email references what shipped, not a generic "we made improvements".
 *
 * Both fail closed: if the LLM call fails, no emails are sent (safer than blasting
 * everyone or sending vague messages).
 */

function getClient() {
  // Same fallback pattern as classifier.ts — handles local dev where the system
  // env may have an empty ANTHROPIC_API_KEY that overrides .env.local.
  const key = process.env.ANTHROPIC_API_KEY

  if (!key || !key.startsWith('sk-')) {
    try {
      const fs = require('fs')
      const path = require('path')
      const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8')
      const match = envFile.match(/^ANTHROPIC_API_KEY="?([^"\n]+)"?$/m)
      if (match?.[1]) return new Anthropic({ apiKey: match[1] })
    } catch {}

    throw new Error('ANTHROPIC_API_KEY is not set or empty')
  }

  return new Anthropic({ apiKey: key })
}

const MATCH_SYSTEM_PROMPT = `You are a matcher that decides whether a product changelog addresses each subscriber's stated need.

For each subscriber's need, return true ONLY when the changelog clearly addresses that need. Synonyms, paraphrases, and feature-equivalent capabilities count as matches. Tangential mentions, partial overlaps, or distant connections do NOT count.

Be strict. False positives (sending an irrelevant email) burn trust. False negatives (missing a real match) just delay a possible recovery.

Return ONLY valid JSON: an object mapping each id to true or false. No preamble, no markdown.

Example output: {"abc-123": true, "def-456": false, "ghi-789": true}`

const MAX_BATCH_SIZE = 50

/**
 * Decide which subscribers' needs are addressed by the changelog.
 * Returns a Set of subscriber IDs that should receive a win-back email.
 *
 * Fails closed: returns empty Set on LLM error or parse failure.
 */
export async function matchChangelogToSubscribers(
  changelogText: string,
  candidates: Array<{ id: string; need: string }>,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set()

  // Chunk for safety — won't hit this in practice
  if (candidates.length > MAX_BATCH_SIZE) {
    const results = new Set<string>()
    for (let i = 0; i < candidates.length; i += MAX_BATCH_SIZE) {
      const batch = candidates.slice(i, i + MAX_BATCH_SIZE)
      const batchResult = await matchChangelogToSubscribers(changelogText, batch)
      batchResult.forEach((id) => results.add(id))
    }
    return results
  }

  const subscriberList = candidates
    .map((c, i) => `${i + 1}. id=${c.id} → "${c.need}"`)
    .join('\n')

  const userPrompt = `CHANGELOG (what we just shipped):
${changelogText}

SUBSCRIBERS (their stated needs when they cancelled):
${subscriberList}

For each subscriber, return true if the changelog addresses their need, else false.
Return ONLY JSON: {"${candidates[0].id}": true, ...}`

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      temperature: 0,
      system: MATCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    let raw = response.content[0].type === 'text' ? response.content[0].text : ''
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()

    const parsed = JSON.parse(raw)
    const validated = z.record(z.string(), z.boolean()).safeParse(parsed)

    if (!validated.success) {
      console.error('[changelog-match] Zod validation failed:', validated.error.issues)
      return new Set()
    }

    const matched = new Set<string>()
    for (const [id, isMatch] of Object.entries(validated.data)) {
      if (isMatch) matched.add(id)
    }
    return matched
  } catch (err) {
    console.error('[changelog-match] LLM call failed:', err)
    return new Set()
  }
}

const GENERATE_SYSTEM_PROMPT = `You write a single short, concrete win-back email to a previously-cancelled subscriber.

A new product update has shipped that addresses their stated need. Your job is to tell them about it specifically — not vaguely.

RULES:
- Reference what actually shipped, using the language from the changelog. Don't say "we made improvements" — say what shipped.
- Reference what they wanted, briefly, so they remember the context.
- Keep it short — 3-5 sentences max.
- End with a single low-pressure call to action: a question like "Want to give it a try?" or "Worth another look?". Not a hard sell.
- Sign with the founder's name.
- Do NOT mention discounts.
- Plain text only — no markdown, no HTML, no signatures beyond the founder name.
- Do NOT include the unsubscribe / reactivation footer — those are appended automatically.

Return ONLY valid JSON: {"subject": "...", "body": "..."}. No preamble, no markdown.`

/**
 * Generate a concrete win-back email for one matched subscriber.
 * Uses the actual changelog text + the subscriber's stated need.
 *
 * Returns null on LLM failure (caller should skip sending).
 */
export async function generateWinBackEmail(params: {
  changelogText: string
  triggerNeed: string
  subscriberName: string | null
  founderName: string
}): Promise<{ subject: string; body: string } | null> {
  const { changelogText, triggerNeed, subscriberName, founderName } = params

  const firstName = subscriberName?.split(' ')[0] ?? 'there'

  const userPrompt = `Subscriber name: ${firstName}
Founder name: ${founderName}

What this subscriber wanted when they cancelled:
${triggerNeed}

What just shipped (changelog):
${changelogText}

Write a short, concrete win-back email referencing what shipped. Return JSON: {"subject": "...", "body": "..."}.`

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      temperature: 0.3,
      system: GENERATE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    })

    let raw = response.content[0].type === 'text' ? response.content[0].text : ''
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()

    const parsed = JSON.parse(raw)
    const validated = z.object({
      subject: z.string().min(1).max(120),
      body: z.string().min(1).max(2000),
    }).safeParse(parsed)

    if (!validated.success) {
      console.error('[changelog-match] generateWinBackEmail validation failed:', validated.error.issues)
      return null
    }

    return validated.data
  } catch (err) {
    console.error('[changelog-match] generateWinBackEmail LLM call failed:', err)
    return null
  }
}

// Exported for testing
export { MATCH_SYSTEM_PROMPT, GENERATE_SYSTEM_PROMPT, MAX_BATCH_SIZE }
