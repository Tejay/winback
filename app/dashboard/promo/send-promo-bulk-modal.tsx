'use client'

import { useEffect, useMemo, useState } from 'react'
import { PromoDropdown, type PromoOption } from './promo-dropdown'
import { GateChip } from './gate-chip'

/**
 * Spec 80 — bulk send-promo modal. Opens from the dashboard's blue
 * action bar when the merchant has multi-selected churned
 * subscribers and clicks "Send promo offer →".
 *
 * Flow:
 *   1. Modal opens with the selected cohort + summary
 *   2. Merchant picks one promo
 *   3. Modal computes per-subscriber eligibility client-side using the
 *      same 4-gate logic as the drawer
 *   4. Merchant sees aggregated counts (X eligible, Y blocked, Z
 *      recently contacted) + a cost preview, clicks Send
 *   5. Modal calls POST /api/subscribers/[id]/send-promo for each
 *      eligible subscriber in parallel (cap at 5 concurrent so we
 *      don't hammer Resend or the LLM). Tracks per-row results.
 *   6. Final summary: "Sent X, failed Y, blocked Z."
 *
 * No per-subscriber email editing in bulk — one template, one body.
 * Per-row tweaks happen via the drawer flow.
 */

interface SubscriberInBulk {
  id: string
  name: string | null
  email: string | null
  mrrCents: number
  stripePriceId: string | null
}

interface Props {
  open: boolean
  subscribers: SubscriberInBulk[]
  promos: PromoOption[]
  onClose: () => void
  /** Optional callback after the send loop completes, to refresh the table. */
  onComplete?: () => void
}

type GateResult = { ok: true } | { ok: false; reason: string }

// Mirrors the drawer's gate-check (kept duplicated to keep this file
// out of server-only imports). See app/dashboard/promo/promo-dropdown.tsx
// for the canonical comment.
function checkGates(promo: PromoOption, stripePriceId: string | null, now = new Date()): GateResult {
  if (!promo.active) return { ok: false, reason: 'Inactive in Stripe' }
  if (promo.redeemBy) {
    const expiresAt = new Date(promo.redeemBy)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return { ok: false, reason: 'Expired' }
  }
  if (promo.maxRedemptions !== null && promo.timesRedeemed >= promo.maxRedemptions) {
    return { ok: false, reason: 'Redemption cap reached' }
  }
  if (promo.appliesToPriceIds.length > 0) {
    if (!stripePriceId) return { ok: false, reason: 'No plan on file' }
    if (!promo.appliesToPriceIds.includes(stripePriceId)) return { ok: false, reason: 'Wrong plan' }
  }
  return { ok: true }
}

type SendResult =
  | { kind: 'pending' }
  | { kind: 'success' }
  | { kind: 'recently_sent' }
  | { kind: 'failed'; reason: string }

export function SendPromoBulkModal({ open, subscribers, promos, onClose, onComplete }: Props) {
  const [selectedPromoId, setSelectedPromoId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<Record<string, SendResult>>({})

  // Reset state on open/close (or when the cohort changes).
  useEffect(() => {
    if (!open) {
      setSelectedPromoId(null); setSending(false); setResults({})
    }
  }, [open])

  // Aggregated eligibility for the currently-selected promo.
  const eligibility = useMemo(() => {
    if (!selectedPromoId) return null
    const promo = promos.find((p) => p.id === selectedPromoId)
    if (!promo) return null
    const eligible: SubscriberInBulk[] = []
    const blocked: Array<{ sub: SubscriberInBulk; reason: string }> = []
    for (const s of subscribers) {
      const g = checkGates(promo, s.stripePriceId)
      if (g.ok) eligible.push(s)
      else blocked.push({ sub: s, reason: g.reason })
    }
    return { promo, eligible, blocked }
  }, [selectedPromoId, subscribers, promos])

  // Cost preview — recovered MRR over 12 months minus discount cost.
  // For percent-off promos, discount = (percentOff / 100) * MRR *
  // duration (months). For amount-off, the metadata doesn't carry the
  // raw amount in cents here yet — we fall back to a simple MRR sum.
  // The math is intentionally rough — it's a sanity check, not a
  // billing-grade calculation.
  const cost = useMemo(() => {
    if (!eligibility) return null
    const mrrCentsSum = eligibility.eligible.reduce((acc, s) => acc + s.mrrCents, 0)
    // 12 months horizon for "Net" line.
    const recoveredOver12mo = mrrCentsSum * 12
    return {
      mrrCentsSum,
      recoveredOver12mo,
    }
  }, [eligibility])

  async function send() {
    if (!selectedPromoId || !eligibility) return
    setSending(true)
    const pending: Record<string, SendResult> = {}
    for (const s of eligibility.eligible) pending[s.id] = { kind: 'pending' }
    setResults(pending)

    // Send in parallel batches of 5 to avoid hammering Resend/LLM.
    const CONCURRENCY = 5
    const queue = [...eligibility.eligible]
    const workers: Array<Promise<void>> = []
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const sub = queue.shift()
          if (!sub) break
          try {
            const res = await fetch(`/api/subscribers/${sub.id}/send-promo`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ improvementId: selectedPromoId }),
            })
            const json = await res.json().catch(() => ({}))
            if (res.ok) {
              setResults((prev) => ({ ...prev, [sub.id]: { kind: 'success' } }))
            } else if (json.error === 'recently_sent') {
              setResults((prev) => ({ ...prev, [sub.id]: { kind: 'recently_sent' } }))
            } else {
              setResults((prev) => ({ ...prev, [sub.id]: { kind: 'failed', reason: json.error ?? `HTTP ${res.status}` } }))
            }
          } catch (e) {
            setResults((prev) => ({ ...prev, [sub.id]: { kind: 'failed', reason: e instanceof Error ? e.message : String(e) } }))
          }
        }
      })())
    }
    await Promise.all(workers)
    setSending(false)
    onComplete?.()
  }

  const summary = useMemo(() => {
    const all = Object.values(results)
    return {
      total:        all.length,
      success:      all.filter((r) => r.kind === 'success').length,
      recentlySent: all.filter((r) => r.kind === 'recently_sent').length,
      failed:       all.filter((r) => r.kind === 'failed').length,
      pending:      all.filter((r) => r.kind === 'pending').length,
    }
  }, [results])

  const sendComplete = summary.total > 0 && summary.pending === 0

  if (!open) return null

  const fmtUsd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-[600px] w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-slate-100 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-slate-900">
              Send promo offer to {subscribers.length} subscriber{subscribers.length === 1 ? '' : 's'}
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">Picked from your current dashboard selection</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-lg leading-none p-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Cohort summary */}
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
            <div className="text-sm">
              <span className="font-semibold tabular-nums">{subscribers.length}</span>{' '}
              <span className="text-slate-700">selected subscriber{subscribers.length === 1 ? '' : 's'}</span>
            </div>
            <div className="text-xs text-slate-500 mt-1.5 line-clamp-2">
              {subscribers.slice(0, 8).map((s) => s.name ?? s.email ?? 'Unknown').join(', ')}
              {subscribers.length > 8 && ` + ${subscribers.length - 8} more`}
            </div>
          </div>

          {/* Promo dropdown — reuses the drawer's component verbatim,
              passing a synthetic single-subscriber view since the
              dropdown itself does per-subscriber gate-check. We
              compute aggregated eligibility separately below. */}
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-blue-600 mb-2">Promo to send</div>
            {/* For the dropdown's own gate display we pass the FIRST
                subscriber's price as the canonical signal. The real
                per-subscriber breakdown happens in the eligibility
                summary below — which is what the merchant should
                actually trust before clicking Send. */}
            <PromoDropdown
              promos={promos}
              subscriber={{ stripePriceId: subscribers[0]?.stripePriceId ?? null }}
              selectedId={selectedPromoId}
              onSelect={setSelectedPromoId}
            />
          </div>

          {/* Aggregated eligibility — only render once a promo is picked. */}
          {eligibility && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-blue-600 mb-2">Eligibility breakdown</div>
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <GateChip status="ok"   label={`${eligibility.eligible.length} eligible`} />
                {eligibility.blocked.length > 0 && (
                  <GateChip status="fail" label={`${eligibility.blocked.length} blocked`} />
                )}
              </div>
              {eligibility.blocked.length > 0 && (
                <div className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 text-xs text-slate-600 space-y-1">
                  {eligibility.blocked.slice(0, 5).map(({ sub, reason }) => (
                    <div key={sub.id}>
                      <span className="font-medium text-slate-900">{sub.name ?? sub.email ?? 'Unknown'}</span>
                      <span className="text-slate-500"> — {reason}</span>
                    </div>
                  ))}
                  {eligibility.blocked.length > 5 && (
                    <div className="text-slate-400 italic">… + {eligibility.blocked.length - 5} more</div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Cost preview — only render when there's at least one eligible. */}
          {eligibility && cost && eligibility.eligible.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-blue-600 mb-2">
                Estimated impact if all {eligibility.eligible.length} eligible reactivate
              </div>
              <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-600">Total recovered MRR</span>
                  <span className="text-slate-900 font-medium">{fmtUsd(cost.mrrCentsSum)} / month</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">Recovered over 12 months</span>
                  <span className="text-slate-900 font-semibold">{fmtUsd(cost.recoveredOver12mo)}</span>
                </div>
                {eligibility.promo.maxRedemptions === null && (
                  <div className="text-[11px] text-slate-400 pt-1">
                    Discount cost depends on per-promo terms and isn&rsquo;t computed here. Estimate is recovered-MRR only.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Send progress / results */}
          {summary.total > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-900 space-y-1">
              {sending && (
                <div>Sending {summary.total - summary.pending} / {summary.total}…</div>
              )}
              {sendComplete && (
                <>
                  <div className="font-semibold">
                    ✓ Sent {summary.success}
                    {summary.recentlySent > 0 && ` · ${summary.recentlySent} skipped (recently contacted)`}
                    {summary.failed > 0 && ` · ${summary.failed} failed`}
                  </div>
                  {summary.failed > 0 && (
                    <div className="text-rose-700 mt-1.5">
                      {Object.entries(results)
                        .filter(([, r]) => r.kind === 'failed')
                        .slice(0, 3)
                        .map(([id, r]) => {
                          const sub = subscribers.find((s) => s.id === id)
                          const reason = r.kind === 'failed' ? r.reason : ''
                          return (
                            <div key={id}>
                              {sub?.name ?? sub?.email ?? id}: {reason}
                            </div>
                          )
                        })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            {sendComplete ? 'Close' : 'Cancel'}
          </button>
          {!sendComplete && (
            <button
              onClick={send}
              disabled={!eligibility || eligibility.eligible.length === 0 || sending}
              className="bg-slate-900 text-white rounded-full px-5 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {sending ? 'Sending…' : `Send to ${eligibility?.eligible.length ?? 0} eligible →`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
