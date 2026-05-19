import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { SubscriberSignals, ClassificationResult } from './types'
import { logEvent } from './events'
import { callWithRetry } from './retry'
import { renderThreadForPrompt } from './conversation'
// Prompt source of truth: /prompts/classifier-system.md
// Regenerate prompts.generated.ts with `npm run prompts:build`.
import { CLASSIFIER_SYSTEM_PROMPT as SYSTEM_PROMPT } from './prompts.generated'

function getClient() {
  // process.env.ANTHROPIC_API_KEY may be empty string locally
  // (Claude Code sets it to empty in system env, overriding .env.local).
  // On Vercel, the env var will be set correctly.
  const key = process.env.ANTHROPIC_API_KEY

  if (!key || !key.startsWith('sk-')) {
    // Local dev fallback: read directly from .env.local
    try {
      const fs = require('fs')
      const path = require('path')
      const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8')
      const match = envFile.match(/^ANTHROPIC_API_KEY="?([^"\n]+)"?$/m)
      // Zero-retention is now the default for Anthropic API usage (no training on API data).
      // The 'anthropic-beta: zero-retention' header was deprecated — verify your org settings
      // at console.anthropic.com to confirm zero-data-retention is enabled at the org level.
      if (match?.[1]) return new Anthropic({ apiKey: match[1] })
    } catch {}

    throw new Error('ANTHROPIC_API_KEY is not set or empty')
  }

  return new Anthropic({ apiKey: key })
}

// Spec 72 — Zod ceilings are set to 2× the prompt's stated allowance for
// each LLM-output field. The prompt instructs the LLM toward a target;
// Zod accepts anything up to 2× that as a forgiveness window. Anything
// in the 1×–2× range emits a `classifier_drift` event (where useful) so
// we can tune the prompt if drift climbs. Anything over 2× is real
// prompt regression and fails validation.
//
// Per-field allowances:
//   firstMessage.subject       : 3–6 words   → ~50 char target → cap 100
//   firstMessage.body          : ≤250 chars  → cap 500
//   cancellationReason         : "short phrase" → ~40 char target → cap 80
//   triggerKeyword             : 1–3 words   → ~25 char target → cap 50
//   triggerNeed                : 1–2 sentences → ~150 char target → cap 300
//   winBackSubject/Body        : deprecated mirror of firstMessage
//   drawerInsight.read         : 1 sentence  → ~100 char target → cap 200
//   drawerInsight.worthKnowing : 1 sentence (may be empty) → cap 200
const ClassificationSchema = z.object({
  tier:                 z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  tierReason:           z.string().default(''),
  cancellationReason:   z.string().max(80, 'cancellationReason exceeds 80-character ceiling (target ~40)'),
  cancellationCategory: z.enum(['Competitor', 'Price', 'Quality', 'Unused', 'Feature', 'Other']),
  confidence:           z.number().min(0).max(1).default(0),
  suppress:             z.boolean().default(false),
  // Spec 54 — accept null in addition to undefined. The model often returns
  // `suppressReason: null` when suppress=false (especially after the spec 54
  // prompt addition that names this field explicitly). Without .nullable()
  // the strict z.string().optional() rejects null and the whole
  // classification fails.
  suppressReason:       z.string().nullable().optional(),
  firstMessage:         z.object({
    subject:       z.string().max(100, 'subject exceeds 100-character ceiling (target ≤50; 3–6 words)'),
    body:          z.string().max(500, 'Body exceeds 500-character ceiling (target 250; Spec 72)'),
    sendDelaySecs: z.number().default(60),
  }).nullable().default(null),
  triggerKeyword: z.string().max(50, 'triggerKeyword exceeds 50-character ceiling (target ~25; 1–3 words)').nullable().default(null),
  triggerNeed:    z.string().max(300, 'triggerNeed exceeds 300-character ceiling (target ~150; 1–2 sentences)').nullable().default(null),
  winBackSubject: z.string().max(100, 'winBackSubject exceeds 100-character ceiling').default(''),
  winBackBody:    z.string().max(500, 'winBackBody exceeds 500-character ceiling (target 250; Spec 72)').default(''),
  // Drawer insight — what the founder sees pinned above the conversation.
  // Purely descriptive; never recommends an action. The founder decides
  // whether to step in. Replaces the deprecated handoff / handoffReasoning
  // fields — there is no automatic handoff anymore. AI keeps running on
  // every subscriber; the founder takes over manually when they want.
  drawerInsight:      z.object({
    read:         z.string().max(200, 'drawerInsight.read exceeds 200-character ceiling (target ~100)').default(''),
    worthKnowing: z.string().max(200, 'drawerInsight.worthKnowing exceeds 200-character ceiling (target ~100)').default(''),
  }).default({ read: '', worthKnowing: '' }),
  recoveryLikelihood: z.enum(['high', 'medium', 'low']).default('low'),
  // DEPRECATED — kept as transitional stubs while consumers migrate to
  // drawerInsight (Phases 2–7). The prompt no longer asks the LLM for
  // these, so the defaults below kick in for every new classification.
  // Remove in Phase 7 once all read-sites are updated.
  handoff:            z.boolean().default(false),
  handoffReasoning:   z.string().default(''),
})

export async function classifySubscriber(
  signals: SubscriberSignals,
  context: { productName?: string; founderName?: string; changelog?: string }
): Promise<ClassificationResult> {
  const userPrompt = buildPrompt(signals, context)

  // Spec 26 — observability: any failure path (API call, JSON parse, Zod
  // validation) emits a classifier_failed event BEFORE re-throwing so we can
  // see the rate of regressions on /admin (model outages, prompt drift
  // producing invalid JSON, schema mismatches after a model update).
  let errorType: 'api' | 'parse' | 'schema' = 'api'
  try {
    // Spec 28 — wrap the Anthropic call in callWithRetry so transient
    // 429s (Tier 2 = 50 RPM) are absorbed inside the function call rather
    // than bubbling up as webhook 5xxs.
    const response = await callWithRetry(
      () =>
        getClient().messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1500,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      { ctx: 'classifier' },
    )

    let raw = response.content[0].type === 'text' ? response.content[0].text : ''

    // Strip markdown code fences if present
    raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()

    errorType = 'parse'
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.error('Raw LLM output:', raw)
      throw new Error('Failed to parse LLM output as JSON')
    }

    // Normalize LLM output — handle common field name variations
    if (parsed.shouldEmail !== undefined && parsed.suppress === undefined) {
      parsed.suppress = !parsed.shouldEmail
    }
    // Derive suppress from tier if missing
    if (parsed.suppress === undefined && parsed.tier === 4) {
      parsed.suppress = true
    }
    // Copy firstMessage to winback fields if missing
    if (parsed.firstMessage && !parsed.winBackSubject) {
      const fm = parsed.firstMessage as Record<string, unknown>
      parsed.winBackSubject = fm.subject ?? ''
      parsed.winBackBody = fm.body ?? ''
    }

    errorType = 'schema'
    const result = ClassificationSchema.safeParse(parsed)
    if (!result.success) {
      console.error('Failed LLM object:', parsed)
      console.error('Zod errors:', result.error.issues)
      throw new Error('LLM output failed Zod validation')
    }

    // Spec 72 — drift signal. AI is instructed to keep body ≤250 chars; Zod
    // accepts up to 350. Anything in between is the LLM missing the target
    // but still within the ceiling — we send it, but log so we can tune
    // the prompt if the drift rate climbs.
    const driftBody = result.data.firstMessage?.body ?? ''
    if (driftBody.length > 250) {
      await logEvent({
        name: 'classifier_drift',
        properties: {
          stripeCustomerId: signals.stripeCustomerId,
          field:            'firstMessage.body',
          bodyLength:       driftBody.length,
          overflow:         driftBody.length - 250,
        },
      })
    }

    return result.data
  } catch (err) {
    await logEvent({
      name: 'classifier_failed',
      properties: {
        stripeCustomerId: signals.stripeCustomerId,
        errorType,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })
    throw err
  }
}

function buildPrompt(
  signals: SubscriberSignals,
  context: { productName?: string; founderName?: string; changelog?: string }
): string {
  return `Classify this cancelled subscriber and generate win-back content.

SUBSCRIBER SIGNALS:
- stripe_customer_id: ${signals.stripeCustomerId}
- email: ${signals.email ?? 'not_provided'}
- name: ${signals.name ?? 'not_provided'}
- plan_name: ${signals.planName}
- mrr_cents: ${signals.mrrCents}
- tenure_days: ${signals.tenureDays}
- ever_upgraded: ${signals.everUpgraded}
- near_renewal: ${signals.nearRenewal}
- payment_failures: ${signals.paymentFailures}
- previous_subs: ${signals.previousSubs}
- stripe_enum: ${signals.stripeEnum ?? 'not_provided'}
- stripe_comment: ${signals.stripeComment ?? 'not_provided'}
- billing_portal_clicked: ${signals.billingPortalClicked ?? false}
- cancelled_at: ${signals.cancelledAt.toISOString()}
- emails_sent: ${signals.emailsSent ?? 0}   (0 = nothing sent yet; 3 is the maximum we will ever send)${
    signals.daysElapsedSinceEvent !== undefined
      ? `
- days_elapsed_since_event: ${signals.daysElapsedSinceEvent}   (spec 54: this subscriber's email was blocked during the merchant's paused window; now being processed by the drain. Factor time decay into your tier + handoff judgement — a "missing feature" cancellation decays fast, a "too expensive" one decays slowly. If the elapsed time has made the email feel stale or weird, set suppress=true with a brief suppressReason. If the recent changelog now addresses their stated need, that's a strong signal to send.)`
      : ''
  }
${(() => {
  const rendered = renderThreadForPrompt(signals.conversationThread, signals.cancelledAt)
  return rendered ? `\n${rendered}\n` : ''
})()}
BUSINESS CONTEXT:
- product_name: ${context.productName ?? 'not_provided'}
- founder_name: ${context.founderName ?? 'not_provided'}
- recent_changelog: ${context.changelog ?? 'not_provided'}

Sign the email with the founder's name if provided, otherwise use "The team".
Return ONLY valid JSON matching the required schema.`
}

// Exported for testing
export { ClassificationSchema }

// ---------------------------------------------------------------------------
// validateFirstMessage — QA helper enforcing the MESSAGE WRITING constraints
// encoded in the SYSTEM_PROMPT. Pure function; safe to call on any body.
// Intended for tests and offline review, NOT wired into the production
// classifier path — an over-strict rejection would drop otherwise-valid
// classifications. Use the `issues` list to track prompt drift over time.
// ---------------------------------------------------------------------------

export interface MessageValidation {
  ok: boolean
  issues: string[]
}

// Phrases the prompt bans — matched case-insensitively as whole phrases.
const BANNED_PHRASES: Array<{ label: string; re: RegExp }> = [
  { label: 'just checking in',      re: /\bjust checking in\b/i },
  { label: 'circling back',         re: /\bcircling back\b/i },
  { label: 'touching base',         re: /\btouching base\b/i },
  { label: 'following up',          re: /\bfollowing up\b/i },
  { label: 'reaching out',          re: /\breaching out\b/i },
  { label: "we'd love to have you back", re: /\bwe['’ ]?d love to have you back\b/i },
  { label: 'valued customer',       re: /\bvalued customer\b/i },
  { label: 'we value your',         re: /\bwe value your\b/i },
  { label: 'we miss you',           re: /\bwe miss you\b/i },
  { label: 'we hate to see you go', re: /\bwe hate to see you go\b/i },
  { label: 'limited time',          re: /\blimited time\b/i },
  { label: 'today only',            re: /\btoday only\b/i },
  { label: 'hurry',                 re: /\bhurry\b/i },
  { label: 'act fast/now/quickly',  re: /\bact (fast|now|quickly)\b/i },
  { label: "don't miss",            re: /\bdon['’]?t miss\b/i },
  { label: 'loyal customer',        re: /\bloyal customer\b/i },
  { label: 'great customer',        re: /\bgreat customer\b/i },
  { label: 'special offer',         re: /\bspecial offer\b/i },
  // Overshoot gratitude / sycophancy — crosses from "warm" into "fluff".
  { label: 'thank you so much',     re: /\bthank you so much\b/i },
  { label: "you're amazing",        re: /\byou['’ ]?re amazing\b/i },
  { label: 'you were amazing',      re: /\byou were amazing\b/i },
  { label: 'mean so much to us',    re: /\bmean so much to us\b/i },
  { label: 'so grateful for you',   re: /\bso grateful for you\b/i },
  { label: 'incredible customer',   re: /\bincredible customer\b/i },
  // Weak feelings close — cheerful but empty.
  { label: 'how are you doing',     re: /\bhow are you doing\b/i },
  { label: 'how have you been',     re: /\bhow have you been\b/i },
  { label: 'no hard feelings',      re: /\bno hard feelings\b/i },
  { label: "hope you're well",      re: /\bhope you['’ ]?re well\b/i },
  // Passive close — makes the next step their job instead of yours.
  { label: 'let me know if',        re: /\blet me know if\b/i },
  { label: 'feel free to reach out',re: /\bfeel free to reach out\b/i },
  // Meta-commentary — tells the reader what you're doing instead of just doing it.
  { label: "i'll keep this brief",  re: /\bi['’ ]?ll keep this brief\b/i },
  { label: 'long story short',      re: /\blong story short\b/i },
  // AI-tell openers — dead giveaways that a machine wrote this.
  { label: 'hope this finds you well', re: /\bhope(s)? this (email )?finds you well\b/i },
  { label: "i'm reaching out because",  re: /\bi['’ ]?m reaching out because\b/i },
  { label: 'i just wanted to say',  re: /\bi just wanted to say\b/i },
]

// Directive reactivation phrases that collide with a "soft pointer + no CTA" body.
// "come back" alone is intentionally NOT flagged — it appears naturally in
// reassurance phrasing like "I'm not going to push you to come back". Only
// directive variants ("come back now/today/soon") count as a CTA.
const CTA_PHRASES = /\b(reactivate|resubscribe|sign back up|click here|restart your|come back (now|today|soon))\b/i

function countSentences(body: string): number {
  // Strip greeting line(s) and signoff lines before counting.
  const core = body
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !/^(hi|hello|hey)\b/i.test(l))   // drop greeting
    .filter(l => !/^[—\-–]\s*\S/.test(l))         // drop "— Name" signoff
    .join(' ')

  if (!core) return 0
  // Split on sentence-ending punctuation followed by whitespace + capital letter.
  // Avoids splitting on "e.g.", "i.e.", decimals, etc.
  const parts = core.split(/(?<=[.!?])\s+(?=[A-Z"'])/).filter(p => p.trim().length > 0)
  return parts.length
}

export function validateFirstMessage(
  body: string,
  tier: 1 | 2 | 3 | 4,
  opts: { hasChangelogMatch?: boolean } = {},
): MessageValidation {
  const issues: string[] = []

  // Tier 4 is suppressed — nothing to validate.
  if (tier === 4) return { ok: true, issues }

  // 1) Length: must be 2 or 3 sentences in the body (greeting/signoff excluded).
  const n = countSentences(body)
  if (n < 2) issues.push(`body has ${n} sentence(s); minimum is 2`)
  if (n > 3) issues.push(`body has ${n} sentences; maximum is 3`)

  // 2) No exclamation marks anywhere.
  if (/!/.test(body)) issues.push('body contains "!" — drop exclamation marks')

  // 3) Banned phrases.
  for (const { label, re } of BANNED_PHRASES) {
    if (re.test(body)) issues.push(`banned phrase: "${label}"`)
  }

  // 4) Result focus — exactly one path.
  const hasQuestion = /\?/.test(body)
  const hasCTA = CTA_PHRASES.test(body)
  if (hasQuestion && hasCTA) {
    issues.push('body stacks a question and a CTA — pick one')
  }

  // 5) Tier-specific close:
  //    - Tier 1 with a changelog match: soft pointer, NOT a question.
  //    - Tier 1 without a match, Tier 2, Tier 3: must end with a single question.
  const mustAskQuestion =
    tier === 2 || tier === 3 || (tier === 1 && !opts.hasChangelogMatch)

  if (mustAskQuestion && !hasQuestion) {
    issues.push(`tier ${tier} body must end with a genuine question`)
  }
  if (tier === 1 && opts.hasChangelogMatch && hasQuestion) {
    issues.push('tier 1 with changelog match must not ask a question — use a soft pointer instead')
  }

  return { ok: issues.length === 0, issues }
}
