import { redirect } from 'next/navigation'
import { auth, userIsAdmin } from '@/lib/auth'

// Defensive — `dateShipped` is a Postgres DATE (Drizzle returns YYYY-MM-DD
// string), but if anything else creeps in (Date, null, undefined) we still
// produce a valid YYYY-MM-DD string instead of crashing the page render.
function toIsoDate(v: unknown): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

function toIsoDateTime(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString()
  if (typeof v === 'string') return v
  return new Date().toISOString()
}

import { db } from '@/lib/db'
import { customers, improvements, improvementMatches, churnedSubscribers, cancellationThemes, recoveries } from '@/lib/schema'
import { and, eq, desc, sql, gte, isNotNull, min, count, inArray } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { ImpersonationBanner } from '@/components/impersonation-banner'
import { ReasonsTabs } from './reasons-tabs'
import { type PromotionView } from './promotions-section'
import { type ThemeView } from './cancellation-themes'
import {
  WbPromotionMetadataSchema,
  formatPromotionTerms,
  describePromotionRestrictions,
} from '@/src/winback/lib/promotions'
import { WINDOW_DAYS } from '@/src/winback/lib/cluster-cancellations'

/**
 * Spec 65 Phase 2 — Winback Reasons page.
 * Spec 75 — narrow to status='published' (archived view is gone from UI)
 * and include matchedCount per row for the "Matched: N customers" badge.
 *
 * Server shell. Auth check, fetch the customer's active reasons + their
 * match counts, hand off to ReasonsClient for interactivity.
 */
export default async function ReasonsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const isAdmin = await userIsAdmin(session.user.id)

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) redirect('/onboarding/stripe')
  if (!customer.stripeAccessToken) redirect('/onboarding/stripe')

  // Spec 75 — single query with LEFT JOIN + COUNT for match counts.
  // Filter to published only — archived rows still exist in DB for
  // attribution but the merchant UI is a living document of what's
  // currently active.
  // Spec 78 — restrict the Improvements list to kind='product'; the
  // Promotions section below pulls the kind='promotion' rows.
  const rows = await db
    .select({
      id:               improvements.id,
      title:            improvements.title,
      description:      improvements.description,
      dateShipped:      improvements.dateShipped,
      status:           improvements.status,
      addressesPattern: improvements.addressesPattern,
      preempted:        improvements.preempted,
      createdAt:        improvements.createdAt,
      matchedCount:     sql<number>`COALESCE(COUNT(${improvementMatches.improvementId}), 0)::int`,
    })
    .from(improvements)
    .leftJoin(improvementMatches, eq(improvementMatches.improvementId, improvements.id))
    .where(and(
      eq(improvements.customerId, customer.id),
      eq(improvements.status, 'published'),
      eq(improvements.kind, 'product'),
    )!)
    .groupBy(improvements.id)
    .orderBy(desc(improvements.dateShipped))

  // Spec 78 — promotion-kind rows, with same match-count join.
  const promotionRowsRaw = await db
    .select({
      id:                improvements.id,
      promotionMetadata: improvements.promotionMetadata,
      status:            improvements.status,
      matchedCount:      sql<number>`COALESCE(COUNT(${improvementMatches.improvementId}), 0)::int`,
    })
    .from(improvements)
    .leftJoin(improvementMatches, eq(improvementMatches.improvementId, improvements.id))
    .where(and(
      eq(improvements.customerId, customer.id),
      eq(improvements.kind, 'promotion'),
    )!)
    .groupBy(improvements.id)
    .orderBy(desc(improvements.createdAt))

  // Spec 79 — per-code 30d recovery metric. One bulk query against the
  // full set of promotion improvement IDs, grouped by improvement.
  // Returns count + MRR sum for each; null when zero. Used to render
  // "Drove X recoveries / $Y MRR (30d)" under each promo option.
  const promoImprovementIds = promotionRowsRaw.map((r) => r.id)
  const recoveryMetricByImprovementId = new Map<string, { count: number; mrrCents: number }>()
  if (promoImprovementIds.length > 0) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const metricRows = await db
      .select({
        improvementId: recoveries.appliedImprovementId,
        recoveryCount: count(),
        mrrCents:      sql<number>`COALESCE(SUM(${recoveries.planMrrCents}), 0)::int`,
      })
      .from(recoveries)
      .where(and(
        inArray(recoveries.appliedImprovementId, promoImprovementIds),
        gte(recoveries.recoveredAt, thirtyDaysAgo),
      ))
      .groupBy(recoveries.appliedImprovementId)

    for (const row of metricRows) {
      if (!row.improvementId) continue
      recoveryMetricByImprovementId.set(row.improvementId, {
        count: Number(row.recoveryCount),
        mrrCents: row.mrrCents,
      })
    }
  }

  const promotionViews: PromotionView[] = []
  for (const row of promotionRowsRaw) {
    const parsed = WbPromotionMetadataSchema.safeParse(row.promotionMetadata)
    if (!parsed.success) continue
    const m = parsed.data
    const { winbackChecks, merchantVerifies } = describePromotionRestrictions(m)
    const metric = recoveryMetricByImprovementId.get(row.id) ?? null
    promotionViews.push({
      id:           row.id,
      code:         m.code,
      description:  formatPromotionTerms(m),
      target:       m.appliesToPriceIds.length === 0 ? 'All plans' : `${m.appliesToPriceIds.length} plan${m.appliesToPriceIds.length === 1 ? '' : 's'}`,
      active:       m.active && row.status === 'published',
      stripePromotionCodeId: m.stripePromotionCodeId,
      stripeAccountId: customer.stripeAccountId,
      winbackChecks,
      merchantVerifies,
      recoveries30dCount:    metric?.count ?? 0,
      recoveries30dMrrCents: metric?.mrrCents ?? 0,
    })
  }

  // Spec 79 — load cancellation themes (LEFT JOIN improvements for the
  // post-ship insights' addressed improvement title/date).
  const themeRows = await db
    .select({
      id:                     cancellationThemes.id,
      addressesImprovementId: cancellationThemes.addressesImprovementId,
      title:                  cancellationThemes.title,
      description:            cancellationThemes.description,
      category:               cancellationThemes.category,
      emoji:                  cancellationThemes.emoji,
      customerCount:          cancellationThemes.customerCount,
      sampleQuotes:           cancellationThemes.sampleQuotes,
      createdAt:              cancellationThemes.createdAt,
      addressesImprovementTitle:       improvements.title,
      addressesImprovementDateShipped: improvements.dateShipped,
    })
    .from(cancellationThemes)
    .leftJoin(improvements, eq(improvements.id, cancellationThemes.addressesImprovementId))
    .where(eq(cancellationThemes.customerId, customer.id))
    .orderBy(desc(cancellationThemes.customerCount), desc(cancellationThemes.createdAt))

  const primaryThemes: ThemeView[] = []
  const postShipInsights: ThemeView[] = []
  let lastClusteredAt: Date | null = null
  for (const r of themeRows) {
    const view: ThemeView = {
      id:                              r.id,
      title:                           r.title,
      description:                     r.description,
      category:                        r.category,
      emoji:                           r.emoji,
      customerCount:                   r.customerCount,
      sampleQuotes:                    r.sampleQuotes,
      addressesImprovementId:          r.addressesImprovementId,
      addressesImprovementTitle:       r.addressesImprovementTitle ?? null,
      addressesImprovementDateShipped: r.addressesImprovementDateShipped ?? null,
    }
    if (r.addressesImprovementId) {
      postShipInsights.push(view)
    } else {
      primaryThemes.push(view)
    }
    const created = r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string)
    if (!lastClusteredAt || created > lastClusteredAt) lastClusteredAt = created
  }

  // Footer counts + empty-state inputs. One round-trip with three aggs.
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const [cancellationStats] = await db
    .select({
      totalInWindow: count(churnedSubscribers.id),
      earliest:      min(churnedSubscribers.cancelledAt),
    })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.customerId, customer.id))
  const cancellationsSoFar = Number(cancellationStats?.totalInWindow ?? 0)
  const earliest = cancellationStats?.earliest instanceof Date
    ? cancellationStats.earliest
    : cancellationStats?.earliest ? new Date(cancellationStats.earliest as unknown as string) : null
  const daysOfHistory = earliest
    ? Math.floor((Date.now() - earliest.getTime()) / (24 * 60 * 60 * 1000))
    : 0

  // "Total unmatched in window" — used to compute single-complaints filter
  // count for the themes-card footer. Only computed when we actually have
  // themes; otherwise the empty state renders and these numbers are unused.
  let totalUnmatchedInWindow = 0
  if (primaryThemes.length > 0 || postShipInsights.length > 0) {
    const [unmatchedAgg] = await db
      .select({
        n: sql<number>`COUNT(*)::int`,
      })
      .from(churnedSubscribers)
      .where(and(
        eq(churnedSubscribers.customerId, customer.id),
        gte(churnedSubscribers.cancelledAt, windowStart),
        isNotNull(churnedSubscribers.triggerNeed),
        eq(churnedSubscribers.triggerNeedConfidence, 'high'),
        sql`NOT EXISTS (SELECT 1 FROM wb_improvement_matches m WHERE m.subscriber_id = ${churnedSubscribers.id})`,
      ))
    totalUnmatchedInWindow = Number(unmatchedAgg?.n ?? 0)
  }
  const themedSubscriberCount = primaryThemes.reduce((sum, t) => sum + t.customerCount, 0)
  const singleComplaints = Math.max(0, totalUnmatchedInWindow - themedSubscriberCount)

  // Spec 79 follow-up — work out the promo label that powers the tab
  // badge ("on · WINBACKE2E25" / "off") without an extra round-trip.
  const selectedPromoView = customer.selectedPromotionImprovementId
    ? promotionViews.find((p) => p.id === customer.selectedPromotionImprovementId) ?? null
    : null

  return (
    <>
      <ImpersonationBanner />
      <TopNav userName={session.user.name} isAdmin={isAdmin} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Win-back</p>
          <h1 className="text-4xl font-bold mt-1 text-slate-900">Why customers come back</h1>
          <p className="text-sm text-slate-500 mt-3 max-w-2xl leading-relaxed">
            Two ways to win back a cancelled customer:{' '}
            <strong className="text-slate-700">ship the feature they wanted</strong>, or{' '}
            <strong className="text-slate-700">offer them a discount</strong>. Win-back emails
            draw from whichever fits each subscriber.
          </p>

          <div className="mt-8">
            <ReasonsTabs
              suggestedProps={{
                primaryThemes,
                postShipInsights,
                lastClusteredAt,
                totalCancellations: totalUnmatchedInWindow,
                singleComplaints,
                windowDays: WINDOW_DAYS,
                cancellationsSoFar,
                daysOfHistory,
              }}
              activeProps={{
                initialReasons: rows.map((r) => ({
                  id:               r.id,
                  title:            r.title,
                  description:      r.description,
                  dateShipped:      toIsoDate(r.dateShipped),
                  addressesPattern: r.addressesPattern ?? null,
                  preempted:        r.preempted,
                  createdAt:        toIsoDateTime(r.createdAt),
                  matchedCount:     r.matchedCount,
                })),
              }}
              promotionsProps={{
                initial:               promotionViews,
                promotionsEnabled:     !!customer.promotionsEnabled,
                autoModeEnabled:       !!customer.promoAutoModeEnabled,
                selectedId:            customer.selectedPromotionImprovementId ?? null,
                stripeAccountId:       customer.stripeAccountId,
              }}
              counts={{
                suggested:  primaryThemes.length,
                active:     rows.length,
                promoOn:    !!customer.promotionsEnabled && !!selectedPromoView,
                promoLabel: selectedPromoView?.code ?? null,
              }}
            />
          </div>
        </div>
      </main>
    </>
  )
}
