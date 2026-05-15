'use client'

/**
 * Spec 73 — shared offset pagination control.
 *
 * Renders smart-truncated numbered nav + Prev/Next + "Showing X–Y of Z"
 * counter. Returns null when there's only one page of results.
 *
 * Caller manages page state and URL state — this component is purely
 * presentational + an onPageChange callback. That keeps it reusable
 * between the dashboard (URL-state-bearing) and the reasons page
 * (no-URL-state, sub-mode toggle).
 */

interface PaginationProps {
  total:    number
  page:     number
  pageSize: number
  /** Called with the new page (1-indexed) when the user clicks a page button. */
  onPageChange: (page: number) => void
  /** Optional override of the "Showing X–Y of Z" labels (e.g. "improvements" instead of "subscribers"). */
  itemLabel?: string
}

/**
 * Build the array of page numbers + ellipses to render.
 *
 * Output examples (current page bolded conceptually):
 *   total=5, page=1     → [1, 2, 3, 4, 5]
 *   total=10, page=5    → [1, '…', 4, 5, 6, '…', 10]
 *   total=10, page=1    → [1, 2, 3, '…', 10]
 *   total=10, page=10   → [1, '…', 8, 9, 10]
 *
 * Rule: always show first + last; show ±1 around current; insert '…'
 * where there's a gap > 1.
 */
function paginationItems(totalPages: number, current: number): Array<number | 'ellipsis'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1)
  }
  const out: Array<number | 'ellipsis'> = [1]
  const start = Math.max(2, current - 1)
  const end   = Math.min(totalPages - 1, current + 1)
  if (start > 2) out.push('ellipsis')
  for (let i = start; i <= end; i++) out.push(i)
  if (end < totalPages - 1) out.push('ellipsis')
  out.push(totalPages)
  return out
}

export function Pagination({ total, page, pageSize, onPageChange, itemLabel = 'items' }: PaginationProps) {
  if (total <= pageSize) return null

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const clamped    = Math.max(1, Math.min(page, totalPages))
  const firstRow   = (clamped - 1) * pageSize + 1
  const lastRow    = Math.min(clamped * pageSize, total)
  const items      = paginationItems(totalPages, clamped)

  return (
    <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
      <p className="text-sm text-slate-500">
        Showing <span className="font-medium text-slate-700">{firstRow}–{lastRow}</span> of{' '}
        <span className="font-medium text-slate-700">{total}</span> {itemLabel}
      </p>

      <nav className="flex items-center gap-1" aria-label="Pagination">
        <button
          type="button"
          onClick={() => onPageChange(clamped - 1)}
          disabled={clamped <= 1}
          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Previous page"
        >
          ← Prev
        </button>

        {/* Desktop: numbered nav with smart truncation */}
        <div className="hidden items-center gap-1 sm:flex">
          {items.map((item, idx) =>
            item === 'ellipsis' ? (
              <span key={`e-${idx}`} className="px-2 text-sm text-slate-400" aria-hidden>…</span>
            ) : (
              <button
                key={item}
                type="button"
                onClick={() => onPageChange(item)}
                aria-current={item === clamped ? 'page' : undefined}
                aria-label={`Page ${item}`}
                className={
                  item === clamped
                    ? 'rounded-full bg-[#0f172a] px-3 py-1.5 text-sm font-medium text-white'
                    : 'rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50'
                }
              >
                {item}
              </button>
            ),
          )}
        </div>

        {/* Mobile: "Page X of Y" instead of full nav */}
        <span className="px-2 text-sm text-slate-600 sm:hidden">
          Page {clamped} of {totalPages}
        </span>

        <button
          type="button"
          onClick={() => onPageChange(clamped + 1)}
          disabled={clamped >= totalPages}
          className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Next page"
        >
          Next →
        </button>
      </nav>
    </div>
  )
}

// Exported for unit testing.
export { paginationItems }
