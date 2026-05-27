/**
 * Spec 80 — small status chip showing whether a promo passes all 4
 * Stripe gates for a given subscriber, or names the first failing gate
 * if not. Used inline in the promo-dropdown row + as a header chip on
 * the bulk-modal aggregated eligibility breakdown.
 *
 * Pure presentational — no business logic. The gate-check itself lives
 * in src/winback/lib/promotion-match.ts and runs server-side on every
 * send (this chip is purely an at-a-glance pre-send signal).
 */

export type GateStatus = 'ok' | 'fail'

interface Props {
  status: GateStatus
  /** Short label. For ok: "All 4 gates pass". For fail: the failing gate name. */
  label: string
}

export function GateChip({ status, label }: Props) {
  const cls =
    status === 'ok'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : 'bg-rose-50 text-rose-700 border-rose-200'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {label}
    </span>
  )
}
