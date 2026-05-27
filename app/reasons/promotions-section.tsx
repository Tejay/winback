'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Spec 78 followup — single-selected-promotion UI.
 *
 * The merchant sees every active Stripe promotion code synced into
 * Winback as a radio row, and picks at most one. Winback emails that
 * promo to subscribers who pass the four bulletproof gates (active,
 * redeemBy, maxRedemptions, appliesToPriceIds); anything Stripe checks
 * at redemption that we don't pre-check (first_time_transaction,
 * minimum_amount, currency mismatch, unknown restrictions) is the
 * merchant's responsibility — shown verbatim under "You verify" so the
 * pick is informed.
 *
 * The promotions-enabled toggle lives on this same card so the merchant
 * sees their full promo state in one place.
 */
export interface PromotionView {
  id:                     string
  code:                   string
  description:            string         // human-readable terms ("25% off · 3 months")
  target:                 string         // "All plans" | "N plans"
  active:                 boolean
  stripePromotionCodeId:  string
  stripeAccountId:        string | null
  winbackChecks:          string[]       // restrictions we DO enforce per-subscriber
  merchantVerifies:       string[]       // restrictions we DON'T enforce — merchant problem
  // Spec 79 — trailing 30d attribution. Zero when the promo has driven
  // no recoveries; UI shows a "Drove X recoveries / $Y MRR" line otherwise.
  recoveries30dCount:     number
  recoveries30dMrrCents:  number
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
  autoModeEnabled,
  selectedId,
  stripeAccountId,
}: {
  initial: PromotionView[]
  promotionsEnabled: boolean
  // Spec 80 — when FALSE (the new default), the matcher's promo path
  // short-circuits. Merchant sends per-subscriber via /dashboard
  // drawer or bulk. When TRUE, today's matcher fires for tier-1 +
  // Price cancellations.
  autoModeEnabled: boolean
  selectedId: string | null
  stripeAccountId: string | null
}) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [lastSync, setLastSync] = useState<{ synced: number; archived: number } | null>(null)

  // Optimistic local state for the toggle + selection so the UI doesn't
  // wait a round-trip before reflecting the pick.
  const [enabledLocal, setEnabledLocal] = useState(promotionsEnabled)
  const [autoModeLocal, setAutoModeLocal] = useState(autoModeEnabled)
  const [selectedLocal, setSelectedLocal] = useState<string | null>(selectedId)
  const [pendingConfirm, setPendingConfirm] = useState<PromotionView | null>(null)
  const [, startTransition] = useTransition()
  const [saveError, setSaveError] = useState<string | null>(null)

  async function patch(body: Record<string, unknown>) {
    setSaveError(null)
    const res = await fetch('/api/customer/promotions-enabled', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(txt || `HTTP ${res.status}`)
    }
  }

  async function toggleEnabled(next: boolean) {
    const prev = enabledLocal
    setEnabledLocal(next)
    try {
      await patch({ enabled: next })
      startTransition(() => router.refresh())
    } catch (err) {
      setEnabledLocal(prev)
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  // Spec 80 — flips the automatic-matcher path on/off. Manual sends
  // (drawer + bulk on /dashboard) are unaffected by this toggle.
  async function toggleAutoMode(next: boolean) {
    const prev = autoModeLocal
    setAutoModeLocal(next)
    try {
      await patch({ autoModeEnabled: next })
      startTransition(() => router.refresh())
    } catch (err) {
      setAutoModeLocal(prev)
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  function requestSelect(promo: PromotionView | null) {
    // Clearing or selecting a promo with no merchant-verified restrictions
    // can apply directly. Otherwise show the confirm dialog first so the
    // merchant explicitly acknowledges the gaps.
    if (!promo || promo.merchantVerifies.length === 0) {
      void applySelect(promo?.id ?? null)
      return
    }
    setPendingConfirm(promo)
  }

  async function applySelect(id: string | null) {
    const prev = selectedLocal
    setSelectedLocal(id)
    setPendingConfirm(null)
    try {
      await patch({ selectedPromotionImprovementId: id })
      startTransition(() => router.refresh())
    } catch (err) {
      setSelectedLocal(prev)
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }

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
            Pick one promotion to send to subscribers who cancel for price. Synced from Stripe ·{' '}
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

      {/* Spec 80 — mode disclosure. Branches on autoModeLocal: manual
          mode explains the new dashboard workflow; automatic mode
          restates the spec-79 matcher rules. */}
      <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/50 px-4 py-3 text-xs text-slate-700 leading-relaxed">
        {autoModeLocal ? (
          <>
            <strong>Automatic mode.</strong> Offered to your{' '}
            <strong>top-tier subscribers</strong> whose cancellation reason
            was <strong>price-related</strong>. Each promo passes four
            real-time Stripe checks before it&rsquo;s sent. Stripe makes the
            final eligibility call at checkout. Dashboard send actions
            remain available for VIP overrides.
          </>
        ) : (
          <>
            <strong>Manual mode.</strong> No promo emails go out
            automatically. Open a churned subscriber from the{' '}
            <a href="/dashboard" className="text-blue-700 underline">dashboard</a>{' '}
            and click &ldquo;Send promo offer&rdquo; — or filter by
            cancellation reason, multi-select, and send to a cohort.
            Stripe gates still re-validate before every send.
          </>
        )}
      </div>

      {/* Spec 80 — automatic-mode toggle. When OFF, matcher's promo
          path is skipped. Independent of the master toggle below;
          both must be true for the matcher to fire. */}
      <div className="mt-3 flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
        <div>
          <div className="text-sm font-medium text-slate-900">Automatic mode</div>
          <div className="text-xs text-slate-500 mt-0.5">
            When on, the matcher auto-sends to tier-1 + price-cancellation subscribers. When off, sends only happen from the dashboard.
          </div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={autoModeLocal}
            onChange={(e) => toggleAutoMode(e.target.checked)}
          />
          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
        </label>
      </div>

      {/* Toggle row */}
      <div className="mt-3 flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
        <div>
          <div className="text-sm font-medium text-slate-900">Send promo emails to price-cancellers</div>
          <div className="text-xs text-slate-500 mt-0.5">
            Master switch. When off, no promo is ever attached — automatic or manual.
          </div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={enabledLocal}
            onChange={(e) => toggleEnabled(e.target.checked)}
          />
          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
        </label>
      </div>

      {refreshError && (
        <div className="mt-3 text-xs text-rose-700">{refreshError}</div>
      )}
      {saveError && (
        <div className="mt-3 text-xs text-rose-700">{saveError}</div>
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
        <div className="mt-5 space-y-2">
          {/* "None" row so the merchant can clear without archiving in Stripe */}
          <label className="flex items-start gap-3 rounded-xl border border-slate-100 p-4 cursor-pointer hover:bg-slate-50">
            <input
              type="radio"
              name="selected-promo"
              className="mt-1"
              checked={selectedLocal === null}
              onChange={() => requestSelect(null)}
            />
            <div>
              <div className="text-sm font-medium text-slate-900">None</div>
              <div className="text-xs text-slate-500 mt-0.5">
                No promo attached. Price-cancellers get the standard re-engagement email.
              </div>
            </div>
          </label>

          {initial.map((p) => {
            const selected = selectedLocal === p.id
            const disabled = !p.active
            return (
              <label
                key={p.id}
                className={`flex items-start gap-3 rounded-xl border p-4 cursor-pointer ${
                  selected
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-100 hover:bg-slate-50'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="selected-promo"
                  className="mt-1"
                  checked={selected}
                  disabled={disabled}
                  onChange={() => !disabled && requestSelect(p)}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-slate-900">{p.code}</span>
                    <span className="text-sm text-slate-500">·</span>
                    <span className="text-sm text-slate-700">{p.description}</span>
                    {!p.active && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-500 border border-slate-200 px-2 py-0.5 text-xs">
                        Inactive in Stripe
                      </span>
                    )}
                    <span className="ml-auto">
                      <StripeLink accountId={p.stripeAccountId} promotionCodeId={p.stripePromotionCodeId} />
                    </span>
                  </div>

                  {/* Spec 79 — per-code 30d attribution. Only renders
                      when this code has driven at least one recovery
                      so unproven codes don't show a noisy "0 recoveries". */}
                  {p.recoveries30dCount > 0 && (
                    <div className="mt-1.5 text-xs text-emerald-700">
                      Drove <strong>{p.recoveries30dCount}</strong>{' '}
                      recover{p.recoveries30dCount === 1 ? 'y' : 'ies'} /{' '}
                      <strong>${(p.recoveries30dMrrCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })} MRR</strong>{' '}
                      in the last 30 days.
                    </div>
                  )}

                  {/* Spec 79 — inline restrictions warning, only when
                      this promo has rules Stripe will enforce at checkout
                      that we don't pre-check (first_time_transaction,
                      minimum_amount, etc.). Silent otherwise. The two-
                      column "Winback checks / You verify" grid was
                      removed: the green column duplicated the rule-
                      disclosure subtitle above, and "You verify"
                      mislabelled what Stripe (not the merchant) actually
                      enforces. */}
                  {p.merchantVerifies.length > 0 && (
                    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                      <strong>Heads up.</strong> Stripe will also enforce
                      these at checkout, so a subscriber who doesn&rsquo;t
                      meet them will see a Stripe rejection on the
                      reactivation page: {p.merchantVerifies.join('; ')}.
                    </div>
                  )}
                </div>
              </label>
            )
          })}
        </div>
      )}

      {/* Confirm dialog for promos with uncovered restrictions */}
      {pendingConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setPendingConfirm(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-900">
              Confirm {pendingConfirm.code}
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              This promo has restrictions Winback can&apos;t pre-check for each
              subscriber:
            </p>
            <ul className="mt-3 rounded-xl bg-amber-50 border border-amber-100 p-3 text-sm text-amber-900 space-y-1">
              {pendingConfirm.merchantVerifies.map((c) => (
                <li key={c}>· {c}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-slate-600">
              Subscribers who don&apos;t meet these will see a Stripe error
              after clicking the link in their email.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingConfirm(null)}
                className="rounded-full border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void applySelect(pendingConfirm.id)}
                className="rounded-full bg-blue-600 text-white px-4 py-2 text-sm hover:bg-blue-700"
              >
                Use {pendingConfirm.code}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
