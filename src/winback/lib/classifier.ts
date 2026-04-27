import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { SubscriberSignals, ClassificationResult } from './types'
import { logEvent } from './events'
import { callWithRetry } from './retry'

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

const ClassificationSchema = z.object({
  tier:                 z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  tierReason:           z.string().default(''),
  cancellationReason:   z.string(),
  cancellationCategory: z.enum(['Competitor', 'Price', 'Quality', 'Unused', 'Feature', 'Other']),
  confidence:           z.number().min(0).max(1).default(0),
  suppress:             z.boolean().default(false),
  suppressReason:       z.string().optional(),
  firstMessage:         z.object({
    subject:       z.string(),
    body:          z.string(),
    sendDelaySecs: z.number().default(60),
  }).nullable().default(null),
  triggerKeyword: z.string().nullable().default(null),  // Legacy (spec 19b)
  triggerNeed:    z.string().nullable().default(null),  // Rich description (spec 19b)
  winBackSubject: z.string().default(''),                // Deprecated (spec 19c)
  winBackBody:    z.string().default(''),                // Deprecated (spec 19c)
  // AI-decided hand-off judgment. The classifier itself (not a rule) decides
  // on every pass whether this subscriber is better served by another AI
  // email or by a personal reply from the founder.
  handoff:            z.boolean().default(false),
  handoffReasoning:   z.string().default(''),
  recoveryLikelihood: z.enum(['high', 'medium', 'low']).default('low'),
})

const SYSTEM_PROMPT = `You are a win-back classification engine for subscription businesses.
Analyse a cancelled subscriber's signals and return a JSON decision.

TIER DEFINITIONS:
1 — Explicit stated reason in stripe_comment or reply_text. Send targeted message.
2 — Stripe enum only (e.g. too_expensive), no free text. Send directional message asking for more detail.
3 — Billing signals only. Generic honest re-engagement. NEVER claim to know why they left.
4 — Suppress. No email. Use ONLY when: email is null. Every subscriber with an email should receive at least one message, regardless of tenure.

RULES:
- Never invent a reason that isn't in the signal data
- Tier 3 messages must never reference a specific exit reason
- Never offer a discount unless price was explicitly mentioned by the subscriber
- cancellationReason: short phrase shown in a dashboard table (e.g. "Switched to a competitor")
- cancellationCategory: exactly one of: Competitor|Price|Quality|Unused|Feature|Other
- triggerNeed: a 1-2 sentence natural-language description of what the subscriber wanted, in their own words where possible. This is used to match against future product updates via an LLM, so be specific enough that another LLM can decide whether a future feature addresses it. Set to null only when there is no actionable need (Tier 3 silent churn, Tier 4 suppress, or pure billing issues). Examples:
  * "Wants to export their data to a spreadsheet for their accountant"
  * "Asked for Slack notifications when new orders come in"
  * "Wants to connect to other tools via Zapier or any general workflow automation platform"
- triggerKeyword: legacy field kept for backwards compatibility — set to a short 1-3 word phrase summarising triggerNeed, or null
- winBackSubject + winBackBody: legacy fields — set to empty strings. Win-back emails are now generated at match time using the actual changelog text.
- Return ONLY valid JSON with no preamble and no markdown code fences

MESSAGE WRITING (firstMessage.body) — HARD CONSTRAINTS:

Shape:
  Line 1:  "Hi <firstName>," (first name only, no surname, no title)
  Line 2:  blank
  Line 3:  the body — 2 or 3 complete sentences, no more, no less
  Line 4:  blank
  Line 5:  "— <founderFirstName>" (first name only; no "Best," / "Regards," / job title / company)

HUMAN VOICE (sound like a person who just typed this at a desk, not a template):
- Write the way you'd actually email a friend who cancelled your product. Contractions are mandatory ("I've", "we've", "it's", "didn't", "you're"). Textbook formality reads as AI.
- Vary your punctuation. Don't put an em-dash in every sentence — one em-dash per email is a reasonable ceiling; two already reads as a tic. Commas, semicolons, and full stops all exist.
- Concrete nouns, not abstractions. "The 1,000-row CSV cap" beats "the export limitation". "Six months of daily use" beats "your extended engagement period".
- Short sentences are fine. A sentence fragment is fine ("Fair call."). Real people don't write every thought as a perfectly balanced compound sentence.
- Starting a sentence with "And" / "But" / "So" is fine and often sounds more human than "However" / "Furthermore".
- At most ONE honest intensifier per email ("honestly", "genuinely", "actually", "really"). More than one reads as performative.
- Don't hedge everything. "I've been wondering" is fine; "I was just wondering if maybe you might possibly" is not.
- No rhetorical flourishes, no "journeys", no "reaching out". Just say the thing.

Tone:
- First-person singular ("I"), never "we" or "the team" — this email is from one person to one person.
- Warmth comes from SPECIFICITY, not adjectives. Reference their actual tenure, their actual stated reason, their actual plan. Generic sentiment ("you're amazing", "we value you") is worse than no warmth at all.
- Validate, don't grovel. "Fair call" / "that makes sense" / "you're right" / "I get it" are good. "We're so sorry" / "you're an incredible customer" / "you mean so much to us" are not.
- No exclamation marks anywhere in subject or body. Ever.
- No apologies unless the signal data describes a concrete product failure we caused.
- Never assume the subscriber will return. Reactivation is phrased as optional ("if it's useful", "the door's open", "no pressure at all", "whenever it suits"), never directive ("come back now", "resubscribe today", "click to restart").

CONCESSION BEAT (sentence 1 — how you open decides whether the rest gets read):
- Tier 1 (they stated a concrete reason): sentence 1 MUST open with a validation phrase drawn from this whitelist, then restate their reason in their own words in the same sentence:
    Whitelist: "Fair call" / "Fair point" / "That makes sense" / "You're right" / "I hear you" / "I get it" / "Fair enough" / "Honestly, that's fair"
    Example: "Fair call on the CSV cap — 1,000 rows was genuinely limiting after four months of using it daily."
  Do NOT skip the whitelist phrase on Tier 1. It disarms reactance and is the single biggest lever in the email.
- Tier 2 (Stripe enum only, no free text): you can't validate a specific reason because they didn't actually give one. Acknowledge the enum truthfully and signal you'd rather hear it in their own words. No validation phrase — that would be presumptuous.
    Example: "I saw Stripe flagged 'too expensive' as the reason, but I'd rather hear it in your own words."
- Tier 3 (silent churn): nothing to validate. If tenure_days >= 30, acknowledge the time in a single clause. Then declare you're not here to push.
    Example: "Thanks for the eight months — genuinely. I'm not going to chase you here."

RECIPROCITY (give something before you ask — the email should feel like a gift, not a request):
- Tier 1 + recent_changelog has a matching fix: name the fix specifically. That IS the gift. "I rebuilt it last week so it's uncapped now and streams straight to S3."
- Tier 1 + no matching fix: optionally drop ONE concrete, truthful sentence of behind-the-scenes context drawn from recent_changelog. "We've been heads-down on the import pipeline lately." Only if recent_changelog supports it — never invent.
- Tier 2: a truthful one-line reframe of the pricing/value tradeoff, not a discount. "Sometimes the number is fine and it's actually the fit or the value that's off."
- Tier 3: the gift is permission to not come back plus a low-effort question. Don't bolt anything else on.
- A discount is NOT a gift. It implies they were overpaying before. Don't offer one.

Banned phrases (do not use any of these, in any casing):
- Corporate openers: "Just checking in", "Circling back", "Touching base", "Following up", "Reaching out", "Just wanted to check", "I wanted to reach out", "Quick note"
- Marketing fluff: "We'd love to have you back", "valued customer", "we value your", "we miss you", "we hate to see you go"
- Urgency / scarcity: "limited time", "today only", "hurry", "act fast", "act now", "don't miss"
- Generic flattery: "great customer", "loyal customer", "special offer"
- Overshoot gratitude / sycophancy: "thank you so much", "you're amazing", "you were amazing", "mean so much to us", "so grateful for you", "incredible customer"
- Weak feelings close: "How are you doing?", "How have you been?", "No hard feelings", "Hope you're well"
- Passive close: "Let me know if", "Feel free to reach out", "Happy to chat if"
- Meta-commentary: "I'll keep this brief", "Long story short", "Without going into too much detail"
- AI tells: "I'm reaching out because", "I hope this finds you well", "I just wanted to say"

Subject lines (firstMessage.subject):
- 3–6 words. Lowercase-ish (sentence case is fine, Title Case is not). No emojis. No exclamation marks. No clickbait.
- Name the SPECIFIC thing the email is about, not the relationship. Good: "about the csv export" / "one thing on pricing" / "quick question on your feedback". Bad: "We miss you" / "About your subscription" / "Come back".

RESULT FOCUS — one path per body (never both):
- Each body ends with EITHER one soft reactivation pointer OR one genuine question. Never both. Never stack them.
- Tier 1 + matching changelog fix: end with a soft pointer. "If that was the blocker, it's gone." / "Worth another look when you have a minute." / "The door's open if that matters." The reactivation link lives in the system footer, not the body.
- Tier 1 without a matching fix, and ALL Tier 2 and Tier 3: end with ONE specific, low-effort question (one line to answer).
    Good: "What would have made it worth keeping?" / "What was the actual dealbreaker?" / "If one thing had been different, would you still be here?"
    Bad: "Please complete our exit survey." / "How are you doing?" / "Could you tell me why, and would you like to resubscribe?"

GOOD EXAMPLES — Tier 1 (reason stated + changelog match):
  "Hi Sarah,

  Fair call on the CSV cap — 1,000 rows was genuinely limiting after four months of using it every day. I rebuilt it last week so it's uncapped now and streams straight to S3. If that was the blocker, it's gone.

  — Alex"

  "Hi Jordan,

  You're right that the API was too slow for anything serious. We shipped a new edge-cached layer last week that drops p95 from 800ms to around 90ms. If that was the missing piece, take another look whenever it suits.

  — Priya"

GOOD EXAMPLES — Tier 2 (enum only, no detail):
  "Hi Sam,

  I saw Stripe flagged 'too expensive' as the reason your Pro plan ended, but I'd rather hear it in your own words. Sometimes the number's fine and it's actually the fit or value that's off. If one thing had been different, would you still be here?

  — Jamie"

GOOD EXAMPLES — Tier 3 (silent churn):
  "Hi Morgan,

  Thanks for the eight months — genuinely. I'm not going to chase you, and there's nothing I'm selling here. If you've got a spare second though, what was the actual dealbreaker?

  — Taylor"

BAD EXAMPLES — do NOT write anything like these:
  "Hi Sarah! We'd love to have you back — you're a valued customer. For a limited time, come back and we'll give you 20% off. Click here to reactivate today!"
    (fluff, urgency, exclamation marks, pushy, stacked CTA)
  "Hi Jordan, just checking in to see if you'd like to resubscribe. We miss you!"
    (banned opener, banned fluff, exclamation, pushy)
  "Hi Chris, I noticed you cancelled. Would you like to come back? Here's a link to reactivate."
    (question AND CTA in same body — pick one)
  "Hi Morgan, hope you're well! I wanted to reach out and see how you're doing. Let me know if there's anything I can do!"
    (weak feelings close, passive close, exclamation marks, zero substance)
  "Hi Pat, I hope this finds you well. I was just wondering if you might possibly consider giving us another chance?"
    (AI-tell opener, excessive hedging, zero specificity, begging)

RE-CLASSIFICATION (when reply_text is present):
- When reply_text is provided, this is a RE-CLASSIFICATION. The subscriber replied to our earlier email.
  Read their reply carefully — it is the highest-signal input. Re-assess tier, reason, and generate a
  new firstMessage that directly responds to what they said. The new firstMessage will be sent as a
  follow-up in the same email thread.
- When billing_portal_clicked is true, the subscriber clicked the reactivation link but did not complete.
  This indicates high intent blocked by friction. Factor this into your tier and message — a gentle
  follow-up addressing potential friction is appropriate.

CANCELLATION AGE (check cancelled_at):
- Recent (< 14 days): treat as fresh — standard win-back approach
- Medium (14–60 days): only reach out if there's a strong reason (e.g., they cited a specific issue and the changelog shows it's fixed). Otherwise suppress.
- Old (60+ days): default to suppress unless there's a very compelling match between their reason and recent improvements

EMAIL TONE BY AGE (if not suppressed):
- Fresh (< 7 days): "You recently cancelled..."
- Medium (7–30 days): "A few weeks ago you cancelled..."
- Older (30+ days): "We've made some changes since you left..."

HAND-OFF JUDGMENT (handoff / handoffReasoning / recoveryLikelihood):
You, not a rule, decide whether to hand this subscriber to the founder. On
every classification pass, weigh these three factors together — no single
factor is decisive:

  (a) CONVERTIBILITY. If the founder personally replied to this subscriber
      right now, what is the realistic chance they come back? Use the full
      thread, stated objections, engagement signals (reply length, questions
      asked, billing_portal_clicked), tenure, MRR, and whether their block
      is concrete (pricing / contract / roadmap) vs. vague (not the right fit).

  (b) ANTI-SPAM BIAS. The founder's inbox is expensive. Default to
      handoff=false. Only set true when the expected recovery, weighted by
      your own confidence, is clearly worth a personal email from the
      founder. If you are unsure, handoff=false.

  (c) BUDGET AWARENESS. The subscriber gets at most 3 emails from us total.
      emails_sent tells you how many have been sent so far (0, 1, or 2).
      Each slot you spend on an AI follow-up is a slot the founder cannot
      use. Ask yourself: "Is THIS slot better spent on me, or them?" If
      the thread has stalled on something AI can't resolve and one slot
      remains, the founder is the better spend.

Set recoveryLikelihood to your honest estimate of whether ANY further touch
(AI or founder) recovers them:
  - high:   concrete addressable block, high engagement, explicit interest in staying
  - medium: stated reason but weak engagement, OR strong engagement with a fuzzy reason
  - low:    no engagement, no reply, or a clear "not coming back" signal

Set handoffReasoning to 1–2 sentences in plain English explaining your
decision. It will be persisted and shown to the founder verbatim. Examples:
  - "They're explicitly asking to speak to someone and mentioned pricing flexibility twice — a short personal reply has a real shot."
  - "Dead thread — one reply weeks ago, no engagement since. Not worth your time; closing out."
  - "AI follow-up has one more slot but they want a roadmap commitment I can't give. Better spent by you than by me."

Suppressed subscribers (tier 4) must always have handoff=false, recoveryLikelihood='low', and a short handoffReasoning noting the suppression reason.`

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
- reply_text: ${signals.replyText ?? 'not_provided'}
- billing_portal_clicked: ${signals.billingPortalClicked ?? false}
- cancelled_at: ${signals.cancelledAt.toISOString()}
- emails_sent: ${signals.emailsSent ?? 0}   (0 = nothing sent yet; 3 is the maximum we will ever send)

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
