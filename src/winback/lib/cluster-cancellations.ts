import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { and, desc, eq, gte, isNotNull, isNull, notInArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import {
  cancellationThemes,
  churnedSubscribers,
  improvements,
  improvementMatches,
} from '@/lib/schema'
import { logEvent } from './events'

/**
 * Spec 79 — AI clusters unmatched cancellations into themes.
 *
 * Inputs per customer:
 *   • Cancellations in the last 90 days that have a triggerNeed AND are
 *     NOT yet matched to any existing improvement (via wb_improvement_matches).
 *   • The customer's shipped improvements (kind='product', published).
 *
 * Outputs (written to wb_cancellation_themes):
 *   • Primary themes — clusters of ≥3 subscribers citing the same problem
 *     that none of the merchant's reasons addresses yet. Rendered on
 *     /reasons as "what to ship next".
 *   • Post-ship insights — themes where ≥3 subscribers cancelled AFTER a
 *     shipped improvement, citing the same problem the improvement was
 *     meant to fix. Signal: the version that shipped didn't satisfy.
 *
 * Snapshot model: each run wipes the customer's prior themes and writes
 * fresh. No theme-id stability across runs by design — the LLM may
 * regroup themes as new data lands, and the UI is meant to read the
 * latest snapshot rather than diff history.
 */

// --------------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------------
const WINDOW_DAYS                = 90
const MIN_CANCELLATIONS_TO_RUN   = 10  // below this, return early — not enough signal
const MIN_THEME_SIZE             = 3   // below this, the LLM is told to drop the cluster
const MAX_INPUT_QUOTES           = 200 // hard cap to keep token budget bounded

// --------------------------------------------------------------------------
// Anthropic client (mirrors the pattern in improvement-match.ts —
// includes the .env.local fallback because node --env-file occasionally
// returns an empty string for certain key shapes)
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
    } catch { /* fall through to throw */ }
    throw new Error('ANTHROPIC_API_KEY is not set')
  }
  return new Anthropic({ apiKey: key })
}

// --------------------------------------------------------------------------
// LLM output schema — strictly validated before any DB write
// --------------------------------------------------------------------------
// Per-theme shape validation. We intentionally do NOT enforce
// min(MIN_THEME_SIZE) here — the LLM occasionally returns sub-threshold
// clusters even when told not to. Rejecting the whole response in that
// case loses good clusters too. Instead, the post-validation filter
// (see filterValidSubscriberIds further down) drops sub-threshold
// clusters after we've also stripped hallucinated subscriber IDs.
const ThemeSchema = z.object({
  title:                  z.string().min(1).max(80),
  description:            z.string().min(1).max(280),
  category:               z.enum(['Price', 'Feature', 'Other']).nullable(),
  emoji:                  z.string().min(1).max(8),
  subscriberIds:          z.array(z.string().uuid()).min(1),
  sampleQuotes:           z.array(z.string().min(1)).min(1).max(5),
  addressesImprovementId: z.string().uuid().nullable(),
})
export type ClusteredTheme = z.infer<typeof ThemeSchema>

const ClusterOutputSchema = z.object({
  themes: z.array(ThemeSchema),
})

// --------------------------------------------------------------------------
// Prompt builder
// --------------------------------------------------------------------------
interface QuoteInput {
  id:           string
  quote:        string
  category:     string | null
  cancelledAt:  string  // ISO
}

interface ShippedImprovementInput {
  id:           string
  title:        string
  description:  string
  dateShipped:  string  // YYYY-MM-DD
}

const CLUSTER_SYSTEM_PROMPT = `You analyze cancellation reasons from cancelled SaaS subscribers and group them into actionable themes for the founder.

Each input is one subscriber's stated reason for cancelling, plus metadata. Cluster these by what the customer ACTUALLY WANTS (or what's MISSING). Customers may use different words for the same underlying need — group them together.

Rules:
1. Each theme MUST include at least ${MIN_THEME_SIZE} subscribers. Drop any cluster below that.
2. Title: 4-6 word noun phrase describing the underlying need (e.g. "Native Slack integration", "SAML / SSO for enterprise"). NOT a category label like "Feature requests".
3. Description: ONE sentence in the founder's voice describing the pattern. Include a specific detail from the quotes when possible (e.g. "Wanted a first-party Slack app with channel routing, not just the Zapier workaround.").
4. Category: 'Price', 'Feature', or 'Other'. Match the cancellation category of the majority of subscribers in the cluster.
5. Emoji: pick one based on cluster size — 5+ subscribers = 🔥, 4 = 📊, 3 = 🌱.
6. subscriberIds: include the exact UUIDs of every subscriber in this cluster.
7. sampleQuotes: pick 2-3 of the most representative quotes from the cluster, verbatim from the input.
8. addressesImprovementId: if a SHIPPED IMPROVEMENT in the merchant's list (provided below) semantically addresses the same need this cluster represents, AND at least 3 subscribers in this cluster cancelled AFTER the improvement's dateShipped (not all — just at least 3), set this to the improvement's id. Otherwise null. The signal is "people are still cancelling over this even though I shipped a fix"; a single pre-ship subscriber in the same cluster doesn't disqualify the insight.

Output ONLY valid JSON of shape:
{ "themes": [ { "title": "...", "description": "...", "category": "Price"|"Feature"|"Other", "emoji": "🔥"|"📊"|"🌱", "subscriberIds": ["..."], "sampleQuotes": ["..."], "addressesImprovementId": null|"..." } ] }

No preamble. No markdown. JSON only.`

function buildUserPrompt(quotes: QuoteInput[], shipped: ShippedImprovementInput[]): string {
  const shippedBlock = shipped.length === 0
    ? '(none — merchant has not shipped any improvements yet)'
    : shipped.map((i) => `- id=${i.id} | shipped ${i.dateShipped} | "${i.title}" — ${i.description}`).join('\n')

  const quotesBlock = quotes.map((q) =>
    `- id=${q.id} | category=${q.category ?? 'unknown'} | cancelled ${q.cancelledAt.slice(0, 10)} | "${q.quote.replace(/"/g, "'")}"`,
  ).join('\n')

  return `MERCHANT'S SHIPPED IMPROVEMENTS:
${shippedBlock}

UNMATCHED CANCELLATIONS (${quotes.length} subscribers, last ${WINDOW_DAYS} days):
${quotesBlock}

Cluster the cancellations into themes per the rules.`
}

// --------------------------------------------------------------------------
// Main entry — cluster + persist for one customer.
// Returns { themesWritten, postShipInsightsWritten, skipped: <reason>? }.
// --------------------------------------------------------------------------
export interface ClusterRunResult {
  themesWritten:           number
  postShipInsightsWritten: number
  skipped?:                'not_enough_data'
}

export async function clusterCancellationsForCustomer(
  customerId: string,
  now: Date = new Date(),
): Promise<ClusterRunResult> {
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)

  // 1. Pull UNMATCHED cancellations in window with a usable triggerNeed.
  //    Unmatched = no row in wb_improvement_matches for this subscriber.
  const matchedSubIds = await db
    .selectDistinct({ id: improvementMatches.subscriberId })
    .from(improvementMatches)
  const matchedIds = matchedSubIds.map((r) => r.id)

  const candidates = await db
    .select({
      id:                   churnedSubscribers.id,
      triggerNeed:          churnedSubscribers.triggerNeed,
      cancellationCategory: churnedSubscribers.cancellationCategory,
      cancelledAt:          churnedSubscribers.cancelledAt,
    })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      gte(churnedSubscribers.cancelledAt, windowStart),
      isNotNull(churnedSubscribers.triggerNeed),
      eq(churnedSubscribers.triggerNeedConfidence, 'high'),
      matchedIds.length > 0
        ? notInArray(churnedSubscribers.id, matchedIds)
        : sql`true`,
    ))
    .orderBy(desc(churnedSubscribers.cancelledAt))
    .limit(MAX_INPUT_QUOTES)

  if (candidates.length < MIN_CANCELLATIONS_TO_RUN) {
    await wipeCustomerThemes(customerId)
    return { themesWritten: 0, postShipInsightsWritten: 0, skipped: 'not_enough_data' }
  }

  // 2. Pull shipped improvements for the post-ship-insight pass.
  const shippedImprovements = await db
    .select({
      id:          improvements.id,
      title:       improvements.title,
      description: improvements.description,
      dateShipped: improvements.dateShipped,
    })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customerId),
      eq(improvements.kind, 'product'),
      eq(improvements.status, 'published'),
    ))

  // 3. Build LLM input + call.
  const quoteInputs: QuoteInput[] = candidates.map((c) => ({
    id:          c.id,
    quote:       (c.triggerNeed ?? '').trim(),
    category:    c.cancellationCategory,
    cancelledAt: (c.cancelledAt instanceof Date ? c.cancelledAt : new Date(c.cancelledAt as unknown as string)).toISOString(),
  }))
  const shippedInputs: ShippedImprovementInput[] = shippedImprovements.map((i) => ({
    id:          i.id,
    title:       i.title,
    description: i.description,
    dateShipped: i.dateShipped,
  }))

  const userPrompt = buildUserPrompt(quoteInputs, shippedInputs)

  const response = await getClient().messages.create({
    model:       'claude-haiku-4-5-20251001',
    max_tokens:  4000,
    temperature: 0,
    system:      CLUSTER_SYSTEM_PROMPT,
    messages:    [{ role: 'user', content: userPrompt }],
  })

  let raw = response.content[0].type === 'text' ? response.content[0].text : ''
  raw = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()

  let parsedOutput: { themes: ClusteredTheme[] }
  try {
    const json = JSON.parse(raw)
    const validated = ClusterOutputSchema.parse(json)
    parsedOutput = validated
  } catch (err) {
    console.error('[cluster-cancellations] failed to parse LLM output', err, raw.slice(0, 500))
    throw new Error(`LLM output failed schema validation: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  // 4. Sanity filter: drop any theme that references subscriber IDs we
  //    didn't actually feed in (LLM hallucination guard) or that links
  //    to an improvement id we didn't feed in.
  const validSubscriberIds = new Set(candidates.map((c) => c.id))
  const validImprovementIds = new Set(shippedImprovements.map((i) => i.id))
  const filteredThemes = parsedOutput.themes
    .map((t) => ({
      ...t,
      subscriberIds: t.subscriberIds.filter((id) => validSubscriberIds.has(id)),
      addressesImprovementId: t.addressesImprovementId && validImprovementIds.has(t.addressesImprovementId)
        ? t.addressesImprovementId
        : null,
    }))
    .filter((t) => t.subscriberIds.length >= MIN_THEME_SIZE)

  // 5. Wipe + insert.
  await wipeCustomerThemes(customerId)

  let themesWritten = 0
  let postShipInsightsWritten = 0
  for (const t of filteredThemes) {
    await db.insert(cancellationThemes).values({
      customerId,
      addressesImprovementId: t.addressesImprovementId,
      title:                  t.title,
      description:            t.description,
      category:               t.category,
      emoji:                  t.emoji,
      customerCount:          t.subscriberIds.length,
      subscriberIds:          t.subscriberIds,
      sampleQuotes:           t.sampleQuotes,
      windowStart,
      windowEnd:              now,
    })
    if (t.addressesImprovementId) {
      postShipInsightsWritten++
    } else {
      themesWritten++
    }
  }

  await logEvent({
    name: 'cancellation_themes_clustered',
    customerId,
    properties: {
      candidates:              candidates.length,
      themesWritten,
      postShipInsightsWritten,
      windowDays:              WINDOW_DAYS,
    },
  })

  return { themesWritten, postShipInsightsWritten }
}

async function wipeCustomerThemes(customerId: string): Promise<void> {
  await db.delete(cancellationThemes).where(eq(cancellationThemes.customerId, customerId))
}

// Re-exported for other callers (e.g. a manual admin trigger) to know
// the threshold without re-reading the constant.
export { MIN_CANCELLATIONS_TO_RUN, MIN_THEME_SIZE, WINDOW_DAYS }
