'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Spec 78 — read-only list of Stripe-synced promotion codes for the
 * merchant. Editing happens in Stripe Dashboard. The Refresh button
 * triggers a manual re-pull (the webhook is the primary sync path).
 *
 * Visual matches the design system tokens in CLAUDE.md: rounded-2xl
 * card, blue-600 section label, status badges using the existing
 * palette.
 */
export interface PromotionView {
  id:            string
  code:          string
  description:   string         // human-readable terms
  target:        string         // 'All plans' | comma-joined plan names
  active:        boolean
  matchedCount:  number
  stripePromotionCodeId: string
  stripeAccountId: string | null
}

function StripeLink({ accountId, promotionCodeId }: { accountId: string | null; promotionCodeId: string }) {
  const href = accountId
    ? `https://dashboard.stripe.com/${accountId}/promotion_codes/${promotionCodeId}`
    : `https://dashboard.stripe.com/promotion_codes/${promotionCodeId}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-slate-400 hover:text-blue-600 text-xs"
      title="Edit in Stripe"
    >
      ↗
    </a>
  )
}

export function PromotionsSection({
  initial,
  promotionsEnabled,
  stripeAccountId,
}: {
  initial: PromotionView[]
  promotionsEnabled: boolean
  stripeAccountId: string | null
}) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<{ synced: number; archived: number } | null>(null)
  const [, startTransition] = useTransition()

  async function refresh() {
    setRefreshing(true)
    setRefreshError(null)
    try {
      const res = await fetch('/api/promotions/refresh', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      setLastSync({ synced: body.synced ?? 0, archived: body.archived ?? 0 })
      startTransition(() => router.refresh())
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="mt-6 bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Promotions
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Synced from Stripe ·{' '}
            <a
              href={stripeAccountId
                ? `https://dashboard.stripe.com/${stripeAccountId}/promotion_codes`
                : 'https://dashboard.stripe.com/promotion_codes'
              }
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              edit in your Stripe Dashboard ↗
            </a>
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : '↻ Refresh from Stripe'}
        </button>
      </div>

      {refreshError && (
        <div className="mt-3 text-xs text-rose-700">{refreshError}</div>
      )}
      {lastSync && !refreshError && (
        <div className="mt-3 text-xs text-slate-500">
          Synced {lastSync.synced}; archived {lastSync.archived}.
        </div>
      )}

      {initial.length === 0 ? (
        <div className="mt-6 text-sm text-slate-500">
          No active promotion codes found in Stripe. Create one in your
          Stripe Dashboard and click Refresh, or wait a moment for the
          webhook to land.
        </div>
      ) : (
        <div className="mt-5">
          <div className="grid grid-cols-12 gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400 pb-3 border-b border-slate-100">
            <div className="col-span-3">Code</div>
            <div className="col-span-4">Terms</div>
            <div className="col-span-2">Target</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-1"></div>
          </div>
          {initial.map((p) => (
            <div
              key={p.id}
              className="grid grid-cols-12 gap-2 py-3 border-b border-slate-100 items-center text-sm last:border-b-0"
            >
              <div className="col-span-3 font-mono text-slate-900">{p.code}</div>
              <div className="col-span-4 text-slate-600">{p.description}</div>
              <div className="col-span-2 text-slate-600 truncate" title={p.target}>{p.target}</div>
              <div className="col-span-2">
                {p.active ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-green-50 text-green-700 border border-green-200 px-2.5 py-0.5 text-xs font-medium">
                    ● Active
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-500 border border-slate-200 px-2.5 py-0.5 text-xs font-medium">
                    ○ Inactive
                  </span>
                )}
              </div>
              <div className="col-span-1 text-right">
                <StripeLink accountId={p.stripeAccountId} promotionCodeId={p.stripePromotionCodeId} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 p-4 bg-blue-50 border border-blue-100 rounded-xl text-xs text-blue-900 leading-relaxed">
        <strong>Heads up.</strong> Promotions only fire when{' '}
        {promotionsEnabled ? (
          <>the toggle in <a href="/settings#billing" className="underline">Settings</a> is on (it is)</>
        ) : (
          <>the toggle in <a href="/settings#billing" className="underline">Settings</a> is on (currently off)</>
        )}{' '}
        and the customer cited price as their cancellation reason.
      </div>
    </div>
  )
}
