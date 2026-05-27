'use client'

import { GateChip } from './gate-chip'

/**
 * Spec 80 — promo selector for the send-promo modal. Renders a radio
 * list of every published promo on the merchant's account, with a
 * per-subscriber gate-check status chip on each row. Disabled rows
 * (any gate failing for THIS subscriber) are dimmed with the failing
 * gate name in a tooltip.
 *
 * Pure client component. Gate logic is duplicated client-side from
 * src/winback/lib/promotion-match.ts to keep this file out of the
 * server-only bundle. The actual server-side validation still runs
 * on every send (the endpoint re-checks all 4 gates) — this is just
 * a pre-send eligibility preview for the merchant.
 */

export interface PromoOption {
  id: string
  code: string
  /** Human-readable summary, e.g. "50% off · 3 months". */
  terms: string
  /** Stripe metadata fields the gate-check needs. */
  active: boolean
  /** ISO timestamp; null = no deadline. */
  redeemBy: string | null
  /** null = unlimited. */
  maxRedemptions: number | null
  timesRedeemed: number
  /** Empty array = applies to all plans. */
  appliesToPriceIds: string[]
}

export interface SubscriberSignal {
  /** Subscriber's current Stripe price id; null = no plan on file. */
  stripePriceId: string | null
}

interface Props {
  promos: PromoOption[]
  subscriber: SubscriberSignal
  selectedId: string | null
  onSelect: (id: string) => void
}

type GateResult = { ok: true } | { ok: false; reason: string }

/**
 * Same 4 Stripe gates as getApplicablePromotionForSubscriber
 * (src/winback/lib/promotion-match.ts) but returns the specific
 * failing gate name. Pure logic — no DB, no network. Kept in sync
 * with the server-side function by convention (both are spec 79
 * truth; either drifting would break the modal UX or the email send).
 */
function checkGates(promo: PromoOption, sub: SubscriberSignal, now = new Date()): GateResult {
  if (!promo.active) return { ok: false, reason: 'Inactive in Stripe' }
  if (promo.redeemBy) {
    const expiresAt = new Date(promo.redeemBy)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) {
      return { ok: false, reason: 'Expired' }
    }
  }
  if (promo.maxRedemptions !== null && promo.timesRedeemed >= promo.maxRedemptions) {
    return { ok: false, reason: 'Redemption cap reached' }
  }
  if (promo.appliesToPriceIds.length > 0) {
    if (!sub.stripePriceId) return { ok: false, reason: 'Subscriber has no plan on file' }
    if (!promo.appliesToPriceIds.includes(sub.stripePriceId)) {
      return { ok: false, reason: 'Wrong plan' }
    }
  }
  return { ok: true }
}

export function PromoDropdown({ promos, subscriber, selectedId, onSelect }: Props) {
  if (promos.length === 0) {
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        No promotion codes synced from Stripe yet. Add one in your Stripe
        Dashboard, then come back here.
      </div>
    )
  }

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      {promos.map((p, i) => {
        const gate = checkGates(p, subscriber)
        const disabled = !gate.ok
        const selected = selectedId === p.id
        const baseCls = selected
          ? 'bg-blue-50'
          : disabled
            ? 'bg-slate-50 opacity-60 cursor-not-allowed'
            : 'hover:bg-slate-50 cursor-pointer'
        return (
          <label
            key={p.id}
            className={`flex items-start gap-3 px-3.5 py-3 ${baseCls} ${i > 0 ? 'border-t border-slate-100' : ''}`}
            title={!gate.ok ? gate.reason : undefined}
          >
            <input
              type="radio"
              name="promo"
              value={p.id}
              disabled={disabled}
              checked={selected}
              onChange={() => !disabled && onSelect(p.id)}
              className="mt-1 cursor-pointer disabled:cursor-not-allowed"
            />
            <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm text-slate-900">{p.code}</span>
              <span className="text-sm text-slate-500">·</span>
              <span className="text-sm text-slate-700">{p.terms}</span>
              <span className="ml-auto">
                <GateChip
                  status={gate.ok ? 'ok' : 'fail'}
                  label={gate.ok ? 'All 4 gates pass' : gate.reason}
                />
              </span>
            </div>
          </label>
        )
      })}
    </div>
  )
}
