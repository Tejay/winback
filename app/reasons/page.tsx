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
import { customers, improvements, improvementMatches } from '@/lib/schema'
import { and, eq, desc, sql } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { ImpersonationBanner } from '@/components/impersonation-banner'
import { ReasonsClient } from './reasons-client'
import { PromotionsSection, type PromotionView } from './promotions-section'
import {
  WbPromotionMetadataSchema,
  formatPromotionTerms,
  describePromotionRestrictions,
} from '@/src/winback/lib/promotions'

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

  const promotionViews: PromotionView[] = []
  for (const row of promotionRowsRaw) {
    const parsed = WbPromotionMetadataSchema.safeParse(row.promotionMetadata)
    if (!parsed.success) continue
    const m = parsed.data
    const { winbackChecks, merchantVerifies } = describePromotionRestrictions(m)
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
    })
  }

  return (
    <>
      <ImpersonationBanner />
      <TopNav userName={session.user.name} isAdmin={isAdmin} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Winback</p>
          <h1 className="text-4xl font-bold mt-1 text-slate-900">Winback reasons — why customers return.</h1>
          <p className="text-sm text-slate-500 mt-3 max-w-2xl">
            This is how cancelled customers learn you fixed what they wanted.
            Add a short, specific line per shipped reason. We do the matching
            and emailing. Up to <strong>10 active reasons</strong> at a time.
          </p>

          <details className="mt-4 max-w-2xl rounded-2xl border border-slate-200 bg-white group">
            <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 flex items-center justify-between rounded-2xl">
              <span>Best practices</span>
              <span className="text-slate-400 text-xs group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="px-5 pb-5 pt-1 text-sm text-slate-600 space-y-4">
              <div>
                <p className="font-medium text-slate-900">When should I add a reason?</p>
                <p className="mt-1">Every time you ship something a cancelled customer might have wanted. There&apos;s no minimum cadence. Most merchants add one every few weeks to a couple of months.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">What makes a good entry?</p>
                <p className="mt-1">Concrete and specific. &quot;Shipped Slack integration with channel routing&quot; is good. &quot;We made improvements to notifications&quot; won&apos;t match anyone.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">What gets sent to customers?</p>
                <p className="mt-1">One personalised email per customer, only when our AI is confident the reason addresses something they explicitly said when they cancelled.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">Can I edit or remove reasons?</p>
                <p className="mt-1">Edit or remove anytime. Add when you have real reasons you want to share with cancelled customers.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">Examples</p>
                <ul className="mt-1 space-y-1">
                  <li><span className="text-green-700">✓</span> Shipped Slack integration with channel routing</li>
                  <li><span className="text-green-700">✓</span> Bulk CSV import — up to 100K rows</li>
                  <li><span className="text-red-600">✗</span> We made improvements to imports</li>
                  <li><span className="text-red-600">✗</span> Big things are coming!</li>
                </ul>
              </div>
            </div>
          </details>

          <div className="mt-8">
            <ReasonsClient initialReasons={rows.map((r) => ({
              id:               r.id,
              title:            r.title,
              description:      r.description,
              dateShipped:      toIsoDate(r.dateShipped),
              addressesPattern: r.addressesPattern ?? null,
              preempted:        r.preempted,
              createdAt:        toIsoDateTime(r.createdAt),
              matchedCount:     r.matchedCount,
            }))} />
          </div>

          {/* Spec 78 — Stripe-native promotions, single-select */}
          <PromotionsSection
            initial={promotionViews}
            promotionsEnabled={!!customer.promotionsEnabled}
            selectedId={customer.selectedPromotionImprovementId ?? null}
            stripeAccountId={customer.stripeAccountId}
          />
        </div>
      </main>
    </>
  )
}
