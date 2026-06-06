import Link from 'next/link'
import { PostShipInsight } from './post-ship-insight'

/**
 * Spec 79 — voice-of-customer surface. Lives inside the Suggested tab
 * on /reasons.
 *
 * Two row types, both fed from wb_cancellation_themes (re-clustered
 * weekly by /api/cron/cluster-cancellations):
 *
 *   • Post-ship insights (addressesImprovementId != null) — rendered at
 *     the top of the pane via <PostShipInsight>. Soft indigo rail card,
 *     dismissible per-merchant in localStorage. Signal: "you shipped X,
 *     but customers cancelled afterwards citing the same problem."
 *
 *   • Primary themes (addressesImprovementId == null) — rendered as a
 *     vertical stack of standalone cards. Each card carries a colored
 *     left rail (red/amber/slate by heat), a big numeric count as the
 *     visual anchor, the description, the quotes inline (no
 *     <details> collapse — they're the highest-value content), and a
 *     "+ Add as reason" Link that hands off to the Active tab editor
 *     via URL params: ?tab=active&prefill_title=...&prefill_description=...
 *
 * Pure server component. Native <details> elements (none right now)
 * would handle expand/collapse without client JS.
 */

export interface ThemeView {
  id:                              string
  title:                           string
  description:                     string
  category:                        string | null
  emoji:                           string | null   // unused in the new design; kept for backward compat with the LLM output schema
  customerCount:                   number
  sampleQuotes:                    string[]
  addressesImprovementId:          string | null
  // For post-ship insights only — the matched improvement's title/date.
  // (Loaded by the page server query via LEFT JOIN.)
  addressesImprovementTitle?:      string | null
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

type Heat = 'hot' | 'warm' | 'cool'

function heatOf(count: number): Heat {
  if (count >= 5) return 'hot'
  if (count >= 4) return 'warm'
  return 'cool'
}

const HEAT_RAIL: Record<Heat, string> = {
  hot:  'border-l-red-600',
  warm: 'border-l-amber-600',
  cool: 'border-l-slate-400',
}

// Soft horizontal fade matching the rail color. Tailwind gradient utilities
// don't accept arbitrary stops cleanly across tones, so we keep these as
// inline style hex tints — short list, no perf concern.
const HEAT_TINT_STYLE: Record<Heat, React.CSSProperties> = {
  hot:  { backgroundImage: 'linear-gradient(to right, #fef2f2 0%, #ffffff 30%)' },
  warm: { backgroundImage: 'linear-gradient(to right, #fffbeb 0%, #ffffff 30%)' },
  cool: { backgroundImage: 'linear-gradient(to right, #f8fafc 0%, #ffffff 30%)' },
}

const HEAT_COUNT_COLOR: Record<Heat, string> = {
  hot:  'text-red-600',
  warm: 'text-amber-700',
  cool: 'text-slate-600',
}

const HEAT_QUOTE_BORDER: Record<Heat, string> = {
  hot:  'border-red-200',
  warm: 'border-amber-200',
  cool: 'border-slate-200',
}

function CategoryPill({ category }: { category: string | null }) {
  if (!category) return null
  return (
    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium bg-white text-slate-600 border border-slate-200 uppercase tracking-wide">
      {category}
    </span>
  )
}

function ThemeCard({ theme }: { theme: ThemeView }) {
  const heat = heatOf(theme.customerCount)
  // ?tab=features keeps the user on the Features tab (where the reasons
  // editor now lives, beside the themes); the prefill_* params open the
  // Add modal pre-filled. ReasonsClient clears the prefill_* once it reads
  // them, preserving tab=features.
  const prefillHref =
    '/reasons?tab=features' +
    `&prefill_title=${encodeURIComponent(theme.title)}` +
    `&prefill_description=${encodeURIComponent(theme.description)}`

  return (
    <div
      className={`rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 ${HEAT_RAIL[heat]}`}
      style={HEAT_TINT_STYLE[heat]}
    >
      <div className="flex items-start gap-6">
        {/* Big count as the visual anchor — no emoji */}
        <div className="text-center shrink-0 w-16">
          <div className={`text-4xl font-bold leading-none ${HEAT_COUNT_COLOR[heat]}`}>{theme.customerCount}</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mt-1.5 font-medium">
            {theme.customerCount === 1 ? 'customer' : 'customers'}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold text-slate-900 text-lg leading-tight">{theme.title}</h4>
            <CategoryPill category={theme.category} />
          </div>
          <p className="text-sm text-slate-700 mt-1.5">{theme.description}</p>
          {theme.sampleQuotes.length > 0 && (
            <ul className={`mt-3 space-y-1.5 pl-3 border-l-2 ${HEAT_QUOTE_BORDER[heat]}`}>
              {theme.sampleQuotes.map((q, i) => (
                <li key={i} className="text-xs text-slate-600 italic">&ldquo;{q}&rdquo;</li>
              ))}
            </ul>
          )}
        </div>

        <Link
          href={prefillHref}
          scroll={false}
          className="bg-[#0f172a] text-white rounded-full px-4 py-2 text-sm font-medium hover:bg-[#1e293b] flex-shrink-0 no-underline"
        >
          + Add as reason
        </Link>
      </div>
    </div>
  )
}

function EmptyState({ cancellationsSoFar, daysOfHistory }: { cancellationsSoFar: number; daysOfHistory: number }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
      <h3 className="text-lg font-semibold text-slate-900">Not enough data yet</h3>
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
      {/* Section header + last-clustered meta */}
      <div className="flex items-start justify-between gap-4 px-1">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">What your cancelled customers asked for</h2>
          <p className="text-sm text-slate-500 mt-1">
            Patterns from the last {windowDays} days, clustered weekly. Add one as a reason when you ship it — we&rsquo;ll notify everyone who asked.
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

      {/* Post-ship insights — rendered above the primary themes because
          they're the most actionable (customers still leaving because
          your shipped version didn't fully solve their problem). */}
      {postShipInsights.map((insight) => (
        <PostShipInsight key={insight.id} insight={insight} />
      ))}

      {/* Primary themes — colored standalone cards */}
      {primaryThemes.map((t) => (
        <ThemeCard key={t.id} theme={t} />
      ))}

      {/* Footer line */}
      {primaryThemes.length > 0 && (
        <div className="text-xs text-slate-500 px-2">
          From <strong>{totalCancellations} unmatched cancellation{totalCancellations === 1 ? '' : 's'}</strong>
          {singleComplaints > 0 && <> · {singleComplaints} single complaint{singleComplaints === 1 ? '' : 's'} filtered out</>}
        </div>
      )}
    </div>
  )
}
