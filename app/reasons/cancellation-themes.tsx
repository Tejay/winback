import Link from 'next/link'

/**
 * Spec 79 — voice-of-customer surface on /reasons.
 *
 * Two row types, both fed from wb_cancellation_themes (re-clustered
 * weekly by /api/cron/cluster-cancellations):
 *
 *   • Post-ship insights (addressesImprovementId != null) — rendered
 *     as an indigo "💡 Insight" strip at the top. Signal: "you shipped
 *     X, but customers cancelled afterwards citing the same problem."
 *
 *   • Primary themes (addressesImprovementId == null) — rendered as the
 *     main "What your cancelled customers asked for" card. Each row has
 *     "+ Add as improvement" that hands off to the existing editor via
 *     URL params (?prefill_title=...&prefill_description=...).
 *
 * Pure server component — no client JS needed. Native <details>
 * elements handle expand/collapse of the quotes lists.
 */

export interface ThemeView {
  id:                     string
  title:                  string
  description:            string
  category:               string | null
  emoji:                  string | null
  customerCount:          number
  sampleQuotes:           string[]
  addressesImprovementId: string | null
  // For post-ship insights only — the matched improvement's title/date.
  // (Loaded by the page server query via LEFT JOIN.)
  addressesImprovementTitle?:     string | null
  addressesImprovementDateShipped?: string | null
}

interface Props {
  primaryThemes:      ThemeView[]
  postShipInsights:   ThemeView[]
  lastClusteredAt:    Date | null
  totalCancellations: number    // unmatched cancellations in window (for footer)
  singleComplaints:   number    // unmatched cancellations not assigned to any cluster
  windowDays:         number
  // Empty-state inputs (when no themes have ever been clustered)
  cancellationsSoFar: number    // total cancellations in window across all categories
  daysOfHistory:      number    // days since customer's first cancellation
}

function CategoryPill({ category }: { category: string | null }) {
  if (!category) return null
  return (
    <span className="rounded-full px-2.5 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
      {category}
    </span>
  )
}

function CountPill({ count }: { count: number }) {
  // Heat tier — matches the mockup's red/amber/slate progression.
  const tone = count >= 5
    ? 'bg-red-50 text-red-700 border-red-200'
    : count >= 4
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-slate-100 text-slate-700 border-slate-200'
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium border ${tone}`}>
      {count} customer{count === 1 ? '' : 's'}
    </span>
  )
}

function Quotes({ quotes, borderColor = 'border-slate-100' }: { quotes: string[]; borderColor?: string }) {
  return (
    <ul className={`mt-2 space-y-1.5 pl-3 border-l-2 ${borderColor}`}>
      {quotes.map((q, i) => (
        <li key={i} className="text-xs text-slate-600 italic">&ldquo;{q}&rdquo;</li>
      ))}
    </ul>
  )
}

function PostShipInsight({ insight }: { insight: ThemeView }) {
  const title = insight.addressesImprovementTitle ?? '(reason)'
  const shipped = insight.addressesImprovementDateShipped
  const shippedAgo = shipped
    ? Math.floor((Date.now() - new Date(shipped + 'T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000))
    : null

  return (
    <div className="bg-indigo-50/60 border border-indigo-200 rounded-2xl px-6 py-4 flex items-start gap-3">
      <div className="text-lg leading-none mt-0.5">💡</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-indigo-700">Insight</span>
          <span className="text-xs text-indigo-500">post-ship feedback</span>
        </div>
        <div className="text-sm font-semibold text-indigo-900 mt-1">
          Customers still cite this after you shipped <span className="italic">&ldquo;{title}&rdquo;</span>.
        </div>
        <p className="text-sm text-indigo-900/80 mt-1 leading-relaxed">
          {shippedAgo !== null && (
            <>You shipped this <strong>{shippedAgo} day{shippedAgo === 1 ? '' : 's'} ago</strong>. </>
          )}
          Since then, <strong>{insight.customerCount} customer{insight.customerCount === 1 ? '' : 's'}</strong> cancelled mentioning the same area — {insight.description.replace(/\.$/, '')}.
        </p>
        {insight.sampleQuotes.length > 0 && (
          <details className="mt-2">
            <summary className="text-xs text-indigo-800 font-medium underline hover:no-underline cursor-pointer select-none">
              See what they said ▸
            </summary>
            <Quotes quotes={insight.sampleQuotes} borderColor="border-indigo-200" />
          </details>
        )}
      </div>
    </div>
  )
}

function ThemeRow({ theme }: { theme: ThemeView }) {
  const emoji = theme.emoji ?? '🌱'
  const prefillHref = `/reasons?prefill_title=${encodeURIComponent(theme.title)}&prefill_description=${encodeURIComponent(theme.description)}`
  return (
    <li className="px-6 py-5 hover:bg-slate-50/40">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-full bg-slate-50 border border-slate-200 flex items-center justify-center flex-shrink-0 text-lg">{emoji}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-slate-900">{theme.title}</h4>
            <CountPill count={theme.customerCount} />
            <CategoryPill category={theme.category} />
          </div>
          <p className="text-sm text-slate-600 mt-1.5">{theme.description}</p>
          {theme.sampleQuotes.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700 select-none">In their own words ▸</summary>
              <Quotes quotes={theme.sampleQuotes} />
            </details>
          )}
        </div>
        <Link
          href={prefillHref}
          scroll={false}
          className="bg-[#0f172a] text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-[#1e293b] flex-shrink-0 no-underline"
        >
          + Add as improvement
        </Link>
      </div>
    </li>
  )
}

function EmptyState({ cancellationsSoFar, daysOfHistory }: { cancellationsSoFar: number; daysOfHistory: number }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
      <p className="text-xs font-semibold tracking-widest uppercase text-blue-600">
        What your cancelled customers asked for
      </p>
      <h3 className="text-lg font-semibold text-slate-900 mt-1">Not enough data yet</h3>
      <p className="text-sm text-slate-500 mt-1 max-w-xl leading-relaxed">
        Themes appear once you&rsquo;ve accumulated <strong className="text-slate-700">3 months of cancellation history</strong> — or sooner if you hit enough volume to cluster meaningfully. We&rsquo;ll start showing themes here automatically as soon as the data&rsquo;s ready.
      </p>
      <div className="mt-3 inline-flex items-center gap-2 text-xs text-slate-400">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300"></span>
        <span>
          {cancellationsSoFar > 0
            ? <>{cancellationsSoFar} cancellation{cancellationsSoFar === 1 ? '' : 's'} so far over {daysOfHistory} day{daysOfHistory === 1 ? '' : 's'} · checked again every Sunday</>
            : <>No cancellations yet · checked again every Sunday</>
          }
        </span>
      </div>
    </div>
  )
}

export function CancellationThemes({
  primaryThemes,
  postShipInsights,
  lastClusteredAt,
  totalCancellations,
  singleComplaints,
  windowDays,
  cancellationsSoFar,
  daysOfHistory,
}: Props) {
  // Cold empty state: nothing has ever been clustered for this customer.
  // The cron silently wipes the table when there's not enough data, so an
  // empty themes table is the signal.
  if (primaryThemes.length === 0 && postShipInsights.length === 0) {
    return <EmptyState cancellationsSoFar={cancellationsSoFar} daysOfHistory={daysOfHistory} />
  }

  const daysSinceCluster = lastClusteredAt
    ? Math.floor((Date.now() - lastClusteredAt.getTime()) / (24 * 60 * 60 * 1000))
    : null

  return (
    <div className="space-y-4">
      {/* Post-ship insights — render each in its own indigo strip */}
      {postShipInsights.map((insight) => (
        <PostShipInsight key={insight.id} insight={insight} />
      ))}

      {/* Primary themes card */}
      {primaryThemes.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="px-6 py-5 border-b border-slate-100 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold tracking-widest uppercase text-blue-600">What your cancelled customers asked for</p>
              <h3 className="text-lg font-semibold text-slate-900 mt-1">Top cancellation themes — last {windowDays} days</h3>
              <p className="text-sm text-slate-500 mt-1">
                Clustered weekly by AI from cancellations not yet addressed by an existing reason. Themes with 3+ customers surface here.
              </p>
            </div>
            <div className="text-right text-xs text-slate-400 shrink-0 pt-1">
              {daysSinceCluster !== null && (
                <>
                  Last clustered{' '}
                  <span className="text-slate-600 font-medium">
                    {daysSinceCluster === 0
                      ? 'today'
                      : `${daysSinceCluster} day${daysSinceCluster === 1 ? '' : 's'} ago`
                    }
                  </span>
                </>
              )}
              <div className="text-slate-400 mt-0.5">Next run: Sun</div>
            </div>
          </div>
          <ul className="divide-y divide-slate-100">
            {primaryThemes.map((t) => (
              <ThemeRow key={t.id} theme={t} />
            ))}
          </ul>
          <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-500">
            <strong>{primaryThemes.length} theme{primaryThemes.length === 1 ? '' : 's'}</strong> from {totalCancellations} unmatched cancellation{totalCancellations === 1 ? '' : 's'}
            {singleComplaints > 0 && <> · {singleComplaints} single complaint{singleComplaints === 1 ? '' : 's'} filtered out</>}
          </div>
        </div>
      )}
    </div>
  )
}
