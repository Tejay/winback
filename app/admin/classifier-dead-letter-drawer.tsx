'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * Spec 76 — classifier dead-letter recovery drawer.
 *
 * Opens from the overview tile when count >= 1. Fetches every currently-
 * stuck classifier row, lets the admin reset attempts per-row. When the
 * queue is empty after a reset, the drawer auto-closes.
 *
 * Reuses the existing per-subscriber reset endpoint
 * (/api/admin/subscribers/[id]/reset-classify) so this surface doesn't
 * need its own mutation route.
 */

interface DeadLetterRow {
  id:                   string
  customer_id:          string
  email:                string | null
  name:                 string | null
  plan_name:            string | null
  mrr_cents:            number
  classify_attempts:    number
  updated_at:           string
  customer_product_name: string | null
  customer_email:       string | null
  last_error:           string | null
}

interface Props {
  open:    boolean
  onClose: () => void
}

export function ClassifierDeadLetterDrawer({ open, onClose }: Props) {
  const [rows, setRows] = useState<DeadLetterRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState<Set<string>>(new Set())
  const [resetError, setResetError] = useState<Map<string, string>>(new Map())

  // Fetch list on open. We re-fetch every time the drawer opens (not
  // a long-running subscription) — admin actions happen in bursts.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setRows(null)
    setError(null)
    setResetError(new Map())
    void fetch('/api/admin/classifier-dead-letter-list', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return
        if (Array.isArray(data.rows)) setRows(data.rows)
        else setError('Unexpected response shape')
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [open])

  // When the queue is cleared via reset (rows transitions from non-empty
  // to empty), show the "Queue cleared" state for a moment and auto-close.
  const isEmpty = rows !== null && rows.length === 0

  async function handleReset(id: string) {
    setResetting((prev) => new Set(prev).add(id))
    setResetError((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    try {
      const res = await fetch(`/api/admin/subscribers/${id}/reset-classify`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      // Drop the row from the list optimistically.
      setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev))
    } catch (err) {
      setResetError((prev) => {
        const next = new Map(prev)
        next.set(id, err instanceof Error ? err.message : String(err))
        return next
      })
    } finally {
      setResetting((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // Auto-close shortly after the queue is cleared. Uses a one-shot
  // setTimeout that gets cleared on unmount or re-open.
  useEffect(() => {
    if (!open || !isEmpty) return
    const t = setTimeout(onClose, 1500)
    return () => clearTimeout(t)
  }, [open, isEmpty, onClose])

  if (!open) return null

  return (
    <>
      {/* Backdrop — click closes */}
      <div className="fixed inset-0 z-40 bg-slate-900/30" onClick={onClose} />

      {/* Drawer */}
      <aside
        className="fixed top-0 right-0 z-50 h-full w-full sm:max-w-md bg-white shadow-xl border-l border-slate-200 flex flex-col"
        role="dialog"
        aria-label="Stuck after 3 tries — AI classifier"
      >
        <header className="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Stuck after 3 tries</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {rows === null
                ? 'Loading…'
                : rows.length === 0
                  ? 'Queue cleared 🎉'
                  : `${rows.length} subscriber${rows.length === 1 ? '' : 's'} stuck after 3 failed classify attempts — reset to put them back in the queue.`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 text-xl leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="m-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          )}

          {rows === null && !error && (
            <div className="p-5 text-sm text-slate-500">Loading dead-lettered rows…</div>
          )}

          {rows && rows.length === 0 && !error && (
            <div className="p-8 text-center text-sm text-slate-500">
              No stuck subscribers right now.
            </div>
          )}

          {rows && rows.length > 0 && (
            <ul className="divide-y divide-slate-100">
              {rows.map((r) => {
                const isResetting = resetting.has(r.id)
                const rowError    = resetError.get(r.id)
                return (
                  <li key={r.id} className="px-5 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/admin/subscribers/${r.id}`}
                          className="text-sm font-medium text-slate-900 hover:text-blue-600 truncate block"
                        >
                          {r.email ?? r.name ?? r.id.slice(0, 8)}
                        </Link>
                        <div className="text-xs text-slate-500 mt-0.5 truncate">
                          {r.customer_product_name ?? r.customer_email ?? '—'}
                          {r.plan_name && <> · {r.plan_name}</>}
                          {r.mrr_cents > 0 && <> · ${(r.mrr_cents / 100).toFixed(2)}/mo</>}
                        </div>
                        <div className="text-xs text-slate-400 mt-1">
                          <strong className="text-slate-600">{r.classify_attempts}</strong> attempts
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleReset(r.id)}
                        disabled={isResetting}
                        className="bg-[#0f172a] text-white rounded-full px-3 py-1.5 text-xs font-medium hover:bg-[#1e293b] disabled:bg-slate-200 disabled:text-slate-400 whitespace-nowrap"
                      >
                        {isResetting ? 'Resetting…' : '↻ Reset'}
                      </button>
                    </div>
                    {r.last_error && (
                      <div
                        className="mt-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-1.5 truncate"
                        title={r.last_error}
                      >
                        {r.last_error.length > 120 ? r.last_error.slice(0, 120) + '…' : r.last_error}
                      </div>
                    )}
                    {rowError && (
                      <div className="mt-2 text-xs text-red-700">Reset failed: {rowError}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-slate-200 text-xs text-slate-500 flex items-center justify-between gap-3">
          <Link
            href="/admin/events?name=classify_dead_lettered"
            onClick={onClose}
            className="hover:text-blue-600"
          >
            Full event history →
          </Link>
          <span className="text-slate-400">Reuses /api/admin/subscribers/[id]/reset-classify</span>
        </footer>
      </aside>
    </>
  )
}
