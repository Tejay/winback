import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { SubscriberSignals, ClassificationResult } from './types'

function getApiKey(): string {
  // process.env.ANTHROPIC_API_KEY may be empty string from system env
  // (e.g. Claude Code sets it to empty). Fall back to reading .env.local directly.
  const key = process.env.ANTHROPIC_API_KEY
  if (key && key.startsWith('sk-')) return key

  // Fallback: read from .env.local
  try {
    const fs = require('fs')
    const path = require('path')
    const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8')
    const match = envFile.match(/^ANTHROPIC_API_KEY="?([^"\n]+)"?$/m)
    if (match?.[1]) return match[1]
  } catch {}

  throw new Error('ANTHROPIC_API_KEY is not set')
}

function getClient() {
  return new Anthropic({ apiKey: getApiKey() })
}

const ClassificationSchema = z.object({
  tier:                 z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  tierReason:           z.string().default(''),
  cancellationReason:   z.string(),
  cancellationCategory: z.enum(['Competitor', 'Price', 'Quality', 'Unused', 'Feature', 'Other']),
  confidence:           z.number().min(0).max(1).default(0),
  suppress:             z.boolean(),
  suppressReason:       z.string().optional(),
  firstMessage:         z.object({
    subject:       z.string(),
    body:          z.string(),
    sendDelaySecs: z.number(),
  }).nullable().default(null),
  triggerKeyword: z.string().nullable().default(null),
  fallbackDays:   z.union([z.literal(30), z.literal(90), z.literal(180)]).default(90),
  winBackSubject: z.string().default(''),
  winBackBody:    z.string().default(''),
})

const SYSTEM_PROMPT = `You are a win-back classification engine for subscription businesses.
Analyse a cancelled subscriber's signals and return a JSON decision.

TIER DEFINITIONS:
1 — Explicit stated reason in stripe_comment or reply_text. Send targeted message.
2 — Stripe enum only (e.g. too_expensive), no free text. Send directional message asking for more detail.
3 — Billing signals only. Generic honest re-engagement. NEVER claim to know why they left.
4 — Suppress. No email. Use when: email is null, tenure < 5 days, obvious test/spam account.

RULES:
- Never invent a reason that isn't in the signal data
- Tier 3 messages must never reference a specific exit reason
- Never offer a discount unless price was explicitly mentioned by the subscriber
- cancellationReason: short phrase shown in a dashboard table (e.g. "Switched to a competitor")
- cancellationCategory: exactly one of: Competitor|Price|Quality|Unused|Feature|Other
- For Tier 2 and Tier 3, always end firstMessage.body with a single genuine question asking why they left. Keep it to one sentence. Frame it as curiosity, not a survey. Good example: "Would you mind sharing what happened? Hit reply — one line is enough." Bad example: "Please complete our exit survey." Do NOT add this question to Tier 1 — they already told you why they left.
- Return ONLY valid JSON with no preamble and no markdown code fences`

export async function classifySubscriber(
  signals: SubscriberSignals,
  context: { productName?: string; founderName?: string; changelog?: string }
): Promise<ClassificationResult> {
  const userPrompt = buildPrompt(signals, context)

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  let raw = response.content[0].type === 'text' ? response.content[0].text : ''

  // Strip markdown code fences if present
  raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error('Raw LLM output:', raw)
    throw new Error('Failed to parse LLM output as JSON')
  }

  const result = ClassificationSchema.safeParse(parsed)
  if (!result.success) {
    console.error('Failed LLM object:', parsed)
    console.error('Zod errors:', result.error.issues)
    throw new Error('LLM output failed Zod validation')
  }

  return result.data
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
- reply_text: not_provided
- cancelled_at: ${signals.cancelledAt.toISOString()}

BUSINESS CONTEXT:
- product_name: ${context.productName ?? 'not_provided'}
- founder_name: ${context.founderName ?? 'not_provided'}
- recent_changelog: ${context.changelog ?? 'not_provided'}

Sign the email with the founder's name if provided, otherwise use "The team".
Return ONLY valid JSON matching the required schema.`
}

// Exported for testing
export { ClassificationSchema }
