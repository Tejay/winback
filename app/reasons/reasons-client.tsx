'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

/**
 * Spec 65 Phase 2 — Winback Reasons client.
 * Spec 75 — UX cleanup:
 *   - "Show removed" toggle + archived view removed entirely
 *   - "Matched: N customers" badge per active row (hidden when N=0)
 *   - Modal-confirmation Remove → optimistic remove + 10s toast-undo
 * The underlying soft-archive (status='archived') stays in DB for
 * attribution lineage; merchants just never see it.
 */

interface Reason {
  id:               string
  title:            string
  description:      string
  dateShipped:      string  // YYYY-MM-DD
  addressesPattern: string | null
  preempted:        boolean
  createdAt:        string
  matchedCount:     number
}

const MAX_ACTIVE = 10
const TOAST_TIMEOUT_MS = 10_000

interface AddPrefill {
  title?:            string
  description?:      string
  addressesPattern?: string
}

type ModalState =
  | { kind: 'closed' }
  | { kind: 'add'; prefill?: AddPrefill }
  | { kind: 'edit'; reason: Reason }

interface PendingUndo {
  reason: Reason  // full row so we can render it back if Undo clicked
  removedAt: number
}

interface Props {
  initialReasons: Reason[]
}

export function ReasonsClient({ initialReasons }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [reasons, setReasons] = useState(initialReasons)
  const [modal, setModal] = useState<ModalState>({ kind: 'closed' })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [pendingUndos, setPendingUndos] = useState<PendingUndo[]>([])

  // Spec 79 — pre-fill the Add modal when the user clicked "+ Add as
  // improvement" on a cancellation theme. Theme rows link to
  // /reasons?prefill_title=...&prefill_description=...
  // We read once on mount, open the modal pre-filled, then clear the
  // params so a refresh doesn't keep re-opening the modal.
  useEffect(() => {
    const title = searchParams.get('prefill_title')
    const description = searchParams.get('prefill_description')
    const addressesPattern = searchParams.get('prefill_pattern')
    if (title || description || addressesPattern) {
      setModal({
        kind: 'add',
        prefill: {
          title:            title ?? undefined,
          description:      description ?? undefined,
          addressesPattern: addressesPattern ?? undefined,
        },
      })
      router.replace('/reasons', { scroll: false })
    }
    // Intentionally only run once on first mount — subsequent searchParams
    // changes after the replace() are our own and should be ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const atCap = reasons.length >= MAX_ACTIVE

  function reload() {
    router.refresh()
  }

  /**
   * Spec 75 — optimistic remove + toast-undo.
   * 1. Hide the row immediately (filter out of state).
   * 2. Fire the soft-archive API call.
   * 3. Push a PendingUndo onto the stack so the toast renders.
   * 4. After TOAST_TIMEOUT_MS, drop the PendingUndo (toast dismisses).
   *    The DB stays in archived state with no further action.
   * 5. If user clicks Undo before timeout: call restore API, push the
   *    full row back into state, drop the PendingUndo.
   */
  async function handleRemove(reason: Reason) {
    setErrorMessage(null)
    // Optimistic: remove from UI immediately.
    setReasons((prev) => prev.filter((r) => r.id !== reason.id))
    // Track for undo.
    setPendingUndos((prev) => [...prev, { reason, removedAt: Date.now() }])
    // Fire archive API (soft-archive in DB).
    try {
      const res = await fetch(`/api/improvements/${reason.id}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorMessage(body.error ?? 'Remove failed')
        // Roll back the optimistic update.
        setReasons((prev) => [reason, ...prev])
        setPendingUndos((prev) => prev.filter((p) => p.reason.id !== reason.id))
      }
    } catch {
      setErrorMessage('Remove failed (network error)')
      setReasons((prev) => [reason, ...prev])
      setPendingUndos((prev) => prev.filter((p) => p.reason.id !== reason.id))
    }
  }

  async function handleUndo(undo: PendingUndo) {
    // Restore in UI immediately. The list order matches what server will
    // return on next refresh (dateShipped desc), so optimistic
    // prepending is fine — reload() below re-sorts authoritatively.
    setReasons((prev) => [undo.reason, ...prev])
    setPendingUndos((prev) => prev.filter((p) => p.reason.id !== undo.reason.id))
    // Fire restore API.
    try {
      const res = await fetch(`/api/improvements/${undo.reason.id}/restore`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setErrorMessage(body.error ?? 'Undo failed')
      } else {
        reload()
      }
    } catch {
      setErrorMessage('Undo failed (network error)')
    }
  }

  // Auto-dismiss pending undos after the timeout. Each entry gets its
  // own timer keyed on the id; cleanup on unmount or list change.
  useEffect(() => {
    const timers = pendingUndos.map((u) => {
      const remaining = Math.max(0, TOAST_TIMEOUT_MS - (Date.now() - u.removedAt))
      return setTimeout(() => {
        setPendingUndos((prev) => prev.filter((p) => p.reason.id !== u.reason.id))
      }, remaining)
    })
    return () => { for (const t of timers) clearTimeout(t) }
  }, [pendingUndos])

  return (
    <>
      {errorMessage && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center justify-between">
          <span>{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="text-red-600 text-xs">Dismiss</button>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between flex-wrap gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Active reasons</p>
            <h3 className="text-lg font-semibold text-slate-900 mt-1">
              {reasons.length} / {MAX_ACTIVE} active reasons.
            </h3>
            <p className="text-sm text-slate-500 mt-1">Latest first. Most merchants add one every couple of months.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => atCap ? setErrorMessage(`You have ${MAX_ACTIVE} active reasons. Remove one to add a new one.`) : setModal({ kind: 'add' })}
              disabled={atCap}
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-200 disabled:text-slate-400"
            >
              + Add a reason
            </button>
          </div>
        </div>

        {reasons.length === 0 ? (
          <EmptyState onAdd={() => setModal({ kind: 'add' })} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {reasons.map((r) => (
              <ReasonRow
                key={r.id}
                reason={r}
                onEdit={() => setModal({ kind: 'edit', reason: r })}
                onRemove={() => handleRemove(r)}
              />
            ))}
          </ul>
        )}
      </div>

      {(modal.kind === 'add' || modal.kind === 'edit') && (
        <ReasonFormModal
          mode={modal.kind}
          initial={modal.kind === 'edit' ? modal.reason : undefined}
          prefill={modal.kind === 'add' ? modal.prefill : undefined}
          onClose={() => setModal({ kind: 'closed' })}
          onSaved={(updated) => {
            setReasons((prev) => {
              if (modal.kind === 'edit') {
                return prev.map((p) => (p.id === updated.id ? updated : p))
              }
              return [updated, ...prev]
            })
            setModal({ kind: 'closed' })
            reload()
          }}
          onError={setErrorMessage}
        />
      )}

      {/* Spec 75 — toast-undo stack. Each pending remove gets its own
          toast; stacked vertically at the bottom of the viewport. */}
      {pendingUndos.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2">
          {pendingUndos.map((u) => (
            <UndoToast key={u.reason.id} undo={u} onUndo={() => handleUndo(u)} />
          ))}
        </div>
      )}
    </>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm text-slate-500">No reasons yet.</p>
      <p className="text-sm text-slate-500 mt-1">Shipped something cancelled customers asked for? Add it.</p>
      <button
        onClick={onAdd}
        className="mt-4 bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
      >
        + Add your first reason
      </button>
    </div>
  )
}

function ReasonRow({
  reason: r,
  onEdit,
  onRemove,
}: {
  reason: Reason
  onEdit: () => void
  onRemove: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <li className="px-6 py-4 group hover:bg-slate-50/60 relative">
      <div className="flex items-start gap-4">
        <div className="text-xs text-slate-400 w-24 pt-0.5 flex-shrink-0">
          <div className="font-medium text-slate-700">{formatDate(r.dateShipped)}</div>
          {r.preempted && <div className="text-slate-400 text-[10px] mt-0.5">pre-emptive</div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-medium text-slate-900 truncate">{r.title}</h4>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 text-lg leading-none px-1"
              aria-label="Actions"
            >
              ⋯
            </button>
          </div>
          <p className="text-sm text-slate-500 mt-1">{r.description}</p>
          {/* Spec 75 — addresses pattern + match count. Slate-400 weight
              so neither competes with the title. Match count hidden when
              0 (visual noise on freshly-added rows). */}
          <div className="flex flex-wrap items-center gap-x-3 mt-1.5 text-xs text-slate-400">
            {r.addressesPattern && (
              <span>Addresses: <span className="text-slate-600">{r.addressesPattern}</span></span>
            )}
            {r.matchedCount > 0 && (
              <span>Matched: <span className="text-slate-600">{r.matchedCount} customer{r.matchedCount === 1 ? '' : 's'}</span></span>
            )}
          </div>
        </div>
      </div>
      {menuOpen && (
        <div className="absolute right-6 top-12 w-44 bg-white border border-slate-200 rounded-xl shadow-lg z-10 py-1 text-sm">
          <button onClick={() => { setMenuOpen(false); onEdit() }} className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700">✎ Edit</button>
          <div className="border-t border-slate-100 my-1" />
          <button onClick={() => { setMenuOpen(false); onRemove() }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600">⌫ Remove</button>
        </div>
      )}
    </li>
  )
}

/**
 * Spec 75 — undo toast. Shows the removed reason title and an Undo
 * action with a live seconds-remaining counter. Auto-dismisses via the
 * parent's setTimeout when the budget expires.
 */
function UndoToast({ undo, onUndo }: { undo: PendingUndo; onUndo: () => void }) {
  const startedAt = useRef(undo.removedAt)
  const [secsLeft, setSecsLeft] = useState(() =>
    Math.max(0, Math.ceil((TOAST_TIMEOUT_MS - (Date.now() - startedAt.current)) / 1000)),
  )
  useEffect(() => {
    const t = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((TOAST_TIMEOUT_MS - (Date.now() - startedAt.current)) / 1000))
      setSecsLeft(remaining)
      if (remaining <= 0) clearInterval(t)
    }, 250)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="bg-slate-900 text-white rounded-full pl-4 pr-2 py-2 text-sm shadow-lg flex items-center gap-3 min-w-[280px]">
      <span className="truncate">
        Removed <span className="font-medium">&ldquo;{undo.reason.title}&rdquo;</span>
      </span>
      <button
        onClick={onUndo}
        className="ml-auto bg-white text-slate-900 rounded-full px-3 py-1 text-xs font-semibold hover:bg-slate-100 whitespace-nowrap"
      >
        Undo ({secsLeft}s)
      </button>
    </div>
  )
}

function ReasonFormModal({
  mode,
  initial,
  prefill,
  onClose,
  onSaved,
  onError,
}: {
  mode: 'add' | 'edit'
  initial?: Reason
  prefill?: AddPrefill
  onClose: () => void
  onSaved: (r: Reason) => void
  onError: (msg: string) => void
}) {
  const [title, setTitle] = useState(initial?.title ?? prefill?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? prefill?.description ?? '')
  const [dateShipped, setDateShipped] = useState(initial?.dateShipped ?? new Date().toISOString().slice(0, 10))
  const [addressesPattern, setAddressesPattern] = useState(initial?.addressesPattern ?? prefill?.addressesPattern ?? '')
  const [confirmed, setConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)

  const titleOk = title.trim().length >= 4 && title.trim().length <= 120
  const descOk  = description.trim().length >= 1 && description.trim().length <= 500
  const dateOk  = !!dateShipped && new Date(dateShipped) <= new Date()
  const canSubmit = titleOk && descOk && dateOk && confirmed && !saving

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSaving(true)
    const body = {
      title: title.trim(),
      description: description.trim(),
      dateShipped,
      addressesPattern: addressesPattern.trim() ? addressesPattern.trim() : null,
      preempted: !addressesPattern.trim(),
    }
    const url    = mode === 'edit' ? `/api/improvements/${initial!.id}` : '/api/improvements'
    const method = mode === 'edit' ? 'PATCH' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      onError(errBody.error ?? 'Save failed')
      return
    }
    const json = await res.json()
    // Spec 75 — preserve existing matchedCount on edit (matches don't
    // change). New rows have 0. The API doesn't return matchedCount
    // on POST/PATCH (only GET does), so we synthesize it here.
    onSaved({
      ...json.improvement,
      dateShipped: typeof json.improvement.dateShipped === 'string'
        ? json.improvement.dateShipped.slice(0, 10)
        : new Date(json.improvement.dateShipped).toISOString().slice(0, 10),
      matchedCount: initial?.matchedCount ?? 0,
    })
  }

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="bg-white rounded-2xl max-w-2xl w-full p-6">
        <h3 className="text-xl font-semibold text-slate-900">
          {mode === 'edit' ? 'Edit reason.' : 'Add a reason.'}
        </h3>
        <p className="text-sm text-slate-500 mt-1">
          A real shipped product reason. Stays live until you remove it.
        </p>

        <div className="grid grid-cols-1 gap-4 mt-6">
          <Field label="Date shipped">
            <input type="date" value={dateShipped} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDateShipped(e.target.value)} className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {!dateOk && <FieldHint>Date must be today or earlier.</FieldHint>}
          </Field>

          <Field label="What did you ship?">
            <input type="text" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Shipped Slack integration" className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <FieldHint>{title.trim().length} / 120 characters · 4 minimum</FieldHint>
          </Field>

          <Field label="Short description">
            <textarea rows={3} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="One or two sentences. Name the feature concretely." className="border border-slate-200 rounded-2xl px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <FieldHint>{description.trim().length} / 500 characters</FieldHint>
          </Field>

          <Field label="Which customer reason does this address? (optional)">
            <input type="text" value={addressesPattern ?? ''} onChange={(e) => setAddressesPattern(e.target.value)} placeholder="e.g. Native Slack integration" className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <FieldHint>Leave blank for pre-emptive ships (no customer asked for it yet).</FieldHint>
          </Field>

          <label className="flex items-start gap-3 cursor-pointer rounded-xl bg-amber-50 border border-amber-200 p-4">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
            <span className="text-sm text-amber-900">
              <strong>I confirm this is real.</strong> The feature is in the live product. Publishing informs cancelled customers who asked for something like this.
            </span>
          </label>
        </div>

        <div className="flex items-center gap-2 mt-6 justify-end">
          <button type="button" onClick={onClose} className="text-slate-500 text-sm px-4 py-2">Cancel</button>
          <button type="submit" disabled={!canSubmit} className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-200 disabled:text-slate-400">
            {saving ? 'Saving…' : (mode === 'edit' ? 'Save changes' : 'Publish reason →')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl">
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-slate-400 mt-1.5">{children}</p>
}

function formatDate(iso: string): string {
  // Render YYYY-MM-DD as "MMM D" (e.g. "May 10")
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}
