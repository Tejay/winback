'use client'

import { useEffect, useState } from 'react'
import { PromoDropdown, type PromoOption, type SubscriberSignal } from './promo-dropdown'
import { EmailPreview } from './email-preview'

/**
 * Spec 80 — single-subscriber send-promo modal opened from the
 * subscriber drawer's "Send promo offer" action.
 *
 * Flow:
 *   1. Merchant clicks "Send promo offer" → modal opens
 *   2. Merchant picks one promo from the dropdown (rows greyed if
 *      their gates fail for this subscriber)
 *   3. Modal POSTs to /api/subscribers/[id]/send-promo with
 *      dryRun=true to populate the email preview
 *   4. Merchant tweaks subject/body if they want
 *   5. Merchant clicks Send → real POST without dryRun → real Resend
 *      delivery + audit-trail row (source='manual', sent_by_user_id)
 *
 * Anti-fatigue: if the server returns 409 'recently_sent', the modal
 * surfaces a "Send anyway?" prompt that retries with allowDuplicate=true.
 */

interface SubscriberInfo {
  id: string
  name: string | null
  email: string | null
  /** Days since cancellation, for display. */
  daysSinceCancel: number | null
  /** Plan label, e.g. "Pro · £39/mo". */
  planLabel: string | null
  /** Stripe price id (for gate-check). */
  stripePriceId: string | null
  /** What the subscriber said when cancelling — short snippet. */
  cancellationReason: string | null
}

interface Props {
  open: boolean
  subscriber: SubscriberInfo
  promos: PromoOption[]
  onClose: () => void
  /** Optional callback after a successful send, e.g. to refresh dashboard. */
  onSent?: () => void
}

type ErrorState =
  | { kind: 'none' }
  | { kind: 'recently_sent'; sentAt: string }
  | { kind: 'gate_failed'; detail: string }
  | { kind: 'other'; message: string }

export function SendPromoModal({ open, subscriber, promos, onClose, onSent }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [draftLoading, setDraftLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<ErrorState>({ kind: 'none' })
  const [sent, setSent] = useState(false)

  // Reset state when the modal opens for a new subscriber or closes.
  useEffect(() => {
    if (!open) {
      setSelectedId(null); setSubject(''); setBody('')
      setError({ kind: 'none' }); setSent(false)
    }
  }, [open, subscriber.id])

  // Fetch the draft (dryRun) whenever a new promo is selected.
  useEffect(() => {
    if (!selectedId || !open) return
    let cancelled = false
    setDraftLoading(true); setError({ kind: 'none' })
    fetch(`/api/subscribers/${subscriber.id}/send-promo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ improvementId: selectedId, dryRun: true }),
    })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) {
          if (json.error === 'gate_failed') {
            setError({ kind: 'gate_failed', detail: json.detail ?? 'Promo failed Stripe gate check.' })
          } else {
            setError({ kind: 'other', message: json.error ?? `HTTP ${res.status}` })
          }
          setSubject(''); setBody('')
          return
        }
        setSubject(json.draft?.subject ?? '')
        setBody(json.draft?.body ?? '')
      })
      .catch((e) => {
        if (cancelled) return
        setError({ kind: 'other', message: e instanceof Error ? e.message : String(e) })
      })
      .finally(() => { if (!cancelled) setDraftLoading(false) })
    return () => { cancelled = true }
  }, [selectedId, open, subscriber.id])

  async function send(allowDuplicate = false) {
    if (!selectedId) return
    setSending(true); setError({ kind: 'none' })
    try {
      const res = await fetch(`/api/subscribers/${subscriber.id}/send-promo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          improvementId:   selectedId,
          subjectOverride: subject,
          bodyOverride:    body,
          allowDuplicate,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (json.error === 'recently_sent') {
          setError({ kind: 'recently_sent', sentAt: json.sentAt })
        } else if (json.error === 'gate_failed') {
          setError({ kind: 'gate_failed', detail: json.detail ?? 'Promo failed Stripe gate check.' })
        } else {
          setError({ kind: 'other', message: json.error ?? `HTTP ${res.status}` })
        }
        return
      }
      setSent(true)
      onSent?.()
      // Close after a brief success flash.
      setTimeout(onClose, 1500)
    } catch (e) {
      setError({ kind: 'other', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl max-w-[560px] w-full max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-slate-100 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-slate-900">Send promo offer</h1>
            <p className="text-xs text-slate-500 mt-0.5">Manually offer a discount to one churned subscriber</p>
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
          {/* Subscriber summary */}
          <div className="bg-slate-50 border border-slate-100 rounded-xl px-4 py-3">
            <div className="font-semibold text-sm text-slate-900">
              {subscriber.name ?? subscriber.email ?? 'Unknown subscriber'}
            </div>
            {(subscriber.planLabel || subscriber.daysSinceCancel !== null) && (
              <div className="text-xs text-slate-500 mt-1">
                {subscriber.planLabel}
                {subscriber.planLabel && subscriber.daysSinceCancel !== null && ' · '}
                {subscriber.daysSinceCancel !== null && `cancelled ${subscriber.daysSinceCancel}d ago`}
              </div>
            )}
            {subscriber.cancellationReason && (
              <div className="text-xs italic text-slate-600 mt-1.5">&ldquo;{subscriber.cancellationReason}&rdquo;</div>
            )}
          </div>

          {/* Promo dropdown */}
          <div>
            <div className="text-[11px] uppercase tracking-wider font-semibold text-blue-600 mb-2">Promo to send</div>
            <PromoDropdown
              promos={promos}
              subscriber={{ stripePriceId: subscriber.stripePriceId } as SubscriberSignal}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>

          {/* Email preview (editable) */}
          {selectedId && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-semibold text-blue-600 mb-2">Email preview</div>
              <EmailPreview
                subject={subject}
                body={body}
                editable
                onSubjectChange={setSubject}
                onBodyChange={setBody}
                loading={draftLoading}
              />
            </div>
          )}

          {/* Errors */}
          {error.kind === 'recently_sent' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 text-xs text-amber-900">
              ⚠ This subscriber already received a promo email on{' '}
              {new Date(error.sentAt).toLocaleDateString()} — send anyway?
              <button
                onClick={() => send(true)}
                className="ml-2 underline font-medium text-amber-900 hover:text-amber-700"
              >
                Send anyway
              </button>
            </div>
          )}
          {error.kind === 'gate_failed' && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg px-3.5 py-2.5 text-xs text-rose-900">
              Stripe rejected this promo for this subscriber: {error.detail}
            </div>
          )}
          {error.kind === 'other' && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg px-3.5 py-2.5 text-xs text-rose-900">
              {error.message}
            </div>
          )}
          {sent && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3.5 py-2.5 text-xs text-emerald-900">
              ✓ Sent. Closing…
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            onClick={() => send(false)}
            disabled={!selectedId || sending || sent || draftLoading || error.kind === 'gate_failed'}
            className="bg-slate-900 text-white rounded-full px-5 py-1.5 text-sm font-medium hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {sending ? 'Sending…' : sent ? 'Sent ✓' : 'Send promo offer →'}
          </button>
        </div>
      </div>
    </div>
  )
}
