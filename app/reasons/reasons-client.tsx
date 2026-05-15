'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'

interface Improvement {
  id:               string
  title:            string
  description:      string
  dateShipped:      string  // YYYY-MM-DD
  status:           'published' | 'archived'
  addressesPattern: string | null
  preempted:        boolean
  createdAt:        string
}

const MAX_ACTIVE = 10

type ModalState =
  | { kind: 'closed' }
  | { kind: 'add' }
  | { kind: 'edit'; improvement: Improvement }
  | { kind: 'archive'; improvement: Improvement }

interface Props {
  initialImprovements: Improvement[]
}

export function ReasonsClient({ initialImprovements }: Props) {
  const router = useRouter()
  const [improvements, setImprovements] = useState(initialImprovements)
  const [showArchived, setShowArchived] = useState(false)
  const [modal, setModal] = useState<ModalState>({ kind: 'closed' })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const published = useMemo(() => improvements.filter((i) => i.status === 'published'), [improvements])
  const archived  = useMemo(() => improvements.filter((i) => i.status === 'archived'),  [improvements])
  const visible   = showArchived ? archived : published

  const atCap = published.length >= MAX_ACTIVE

  function reload() {
    router.refresh()
  }

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
            <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
              {showArchived ? 'Removed reasons' : 'Active reasons'}
            </p>
            <h3 className="text-lg font-semibold text-slate-900 mt-1">
              {showArchived ? `${archived.length} removed` : `${published.length} / ${MAX_ACTIVE} active reasons.`}
            </h3>
            {!showArchived && (
              <p className="text-sm text-slate-500 mt-1">Latest first. Most merchants add one every couple of months.</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowArchived((v) => !v)}
              className="text-sm text-slate-500 hover:text-slate-900 px-3 py-1.5"
            >
              {showArchived ? '← Active' : `Show removed (${archived.length})`}
            </button>
            <button
              onClick={() => atCap ? setErrorMessage(`You have ${MAX_ACTIVE} active reasons. Remove one to add a new one.`) : setModal({ kind: 'add' })}
              disabled={atCap}
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-200 disabled:text-slate-400"
            >
              + Add a reason
            </button>
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState showArchived={showArchived} onAdd={() => setModal({ kind: 'add' })} />
        ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((i) => (
              <ImprovementRow
                key={i.id}
                improvement={i}
                onEdit={() => setModal({ kind: 'edit', improvement: i })}
                onArchive={() => setModal({ kind: 'archive', improvement: i })}
                onRestore={async () => {
                  setErrorMessage(null)
                  const res = await fetch(`/api/improvements/${i.id}/restore`, { method: 'POST' })
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({}))
                    setErrorMessage(body.error ?? 'Restore failed')
                    return
                  }
                  reload()
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {(modal.kind === 'add' || modal.kind === 'edit') && (
        <ImprovementFormModal
          mode={modal.kind}
          initial={modal.kind === 'edit' ? modal.improvement : undefined}
          onClose={() => setModal({ kind: 'closed' })}
          onSaved={(updated) => {
            setImprovements((prev) => {
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

      {modal.kind === 'archive' && (
        <ArchiveConfirmModal
          improvement={modal.improvement}
          onClose={() => setModal({ kind: 'closed' })}
          onArchived={() => {
            setImprovements((prev) =>
              prev.map((p) => (p.id === modal.improvement.id ? { ...p, status: 'archived' } : p)),
            )
            setModal({ kind: 'closed' })
            reload()
          }}
          onError={setErrorMessage}
        />
      )}
    </>
  )
}

function EmptyState({ showArchived, onAdd }: { showArchived: boolean; onAdd: () => void }) {
  if (showArchived) {
    return <div className="px-6 py-12 text-center text-sm text-slate-500">No removed reasons.</div>
  }
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

function ImprovementRow({
  improvement: i,
  onEdit,
  onArchive,
  onRestore,
}: {
  improvement: Improvement
  onEdit: () => void
  onArchive: () => void
  onRestore: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isArchived = i.status === 'archived'
  return (
    <li className="px-6 py-4 group hover:bg-slate-50/60 relative">
      <div className="flex items-start gap-4">
        <div className="text-xs text-slate-400 w-24 pt-0.5 flex-shrink-0">
          <div className="font-medium text-slate-700">{formatDate(i.dateShipped)}</div>
          {i.preempted && <div className="text-slate-400 text-[10px] mt-0.5">pre-emptive</div>}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-medium text-slate-900 truncate">{i.title}</h4>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-700 text-lg leading-none px-1"
              aria-label="Actions"
            >
              ⋯
            </button>
          </div>
          <p className="text-sm text-slate-500 mt-1">{i.description}</p>
          {i.addressesPattern && (
            <p className="text-xs text-slate-400 mt-1.5">
              Addresses: <span className="text-slate-600">{i.addressesPattern}</span>
            </p>
          )}
        </div>
      </div>
      {menuOpen && (
        <div className="absolute right-6 top-12 w-44 bg-white border border-slate-200 rounded-xl shadow-lg z-10 py-1 text-sm">
          <button onClick={() => { setMenuOpen(false); onEdit() }} className="w-full text-left px-3 py-1.5 hover:bg-slate-50 text-slate-700">✎ Edit</button>
          <div className="border-t border-slate-100 my-1" />
          {isArchived ? (
            <button onClick={() => { setMenuOpen(false); onRestore() }} className="w-full text-left px-3 py-1.5 hover:bg-green-50 text-green-700">↺ Restore</button>
          ) : (
            <button onClick={() => { setMenuOpen(false); onArchive() }} className="w-full text-left px-3 py-1.5 hover:bg-red-50 text-red-600">⌫ Remove</button>
          )}
        </div>
      )}
    </li>
  )
}

function ImprovementFormModal({
  mode,
  initial,
  onClose,
  onSaved,
  onError,
}: {
  mode: 'add' | 'edit'
  initial?: Improvement
  onClose: () => void
  onSaved: (i: Improvement) => void
  onError: (msg: string) => void
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [dateShipped, setDateShipped] = useState(initial?.dateShipped ?? new Date().toISOString().slice(0, 10))
  const [addressesPattern, setAddressesPattern] = useState(initial?.addressesPattern ?? '')
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
    onSaved({
      ...json.improvement,
      dateShipped: typeof json.improvement.dateShipped === 'string'
        ? json.improvement.dateShipped.slice(0, 10)
        : new Date(json.improvement.dateShipped).toISOString().slice(0, 10),
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

function ArchiveConfirmModal({
  improvement,
  onClose,
  onArchived,
  onError,
}: {
  improvement: Improvement
  onClose: () => void
  onArchived: () => void
  onError: (msg: string) => void
}) {
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!confirmed || submitting) return
    setSubmitting(true)
    const res = await fetch(`/api/improvements/${improvement.id}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      onError(errBody.error ?? 'Remove failed')
      return
    }
    onArchived()
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-white rounded-2xl max-w-md w-full p-6">
        <h4 className="font-semibold text-slate-900 text-lg">Remove reason?</h4>
        <p className="text-sm text-slate-600 mt-2">No new matches after removal. Past emails stay sent.</p>
        <label className="flex items-start gap-3 cursor-pointer mt-4">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-sm text-slate-700">Confirm removal.</span>
        </label>
        <div className="flex items-center justify-end gap-2 mt-5">
          <button onClick={onClose} className="text-slate-500 text-sm px-4 py-2">Cancel</button>
          <button
            onClick={submit}
            disabled={!confirmed || submitting}
            className="bg-red-600 text-white rounded-full px-5 py-2 text-sm font-medium disabled:bg-slate-200 disabled:text-slate-400"
          >
            {submitting ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
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
