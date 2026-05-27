'use client'

/**
 * Spec 80 — email preview pane for the send-promo modals.
 *
 * Two modes:
 *   - editable: text inputs for subject + body. Used by the drawer
 *     modal so the merchant can tweak the LLM-drafted email before
 *     sending.
 *   - readonly: rendered as-is. Used by the bulk modal where there's
 *     one body shared across N subscribers (per-recipient tweaks
 *     happen via the drawer flow).
 *
 * Pure presentational. Caller wires the controlled inputs and the
 * draft loading state.
 */

interface Props {
  subject: string
  body: string
  editable: boolean
  onSubjectChange?: (next: string) => void
  onBodyChange?: (next: string) => void
  /** Optional loading state while the dry-run draft is fetching. */
  loading?: boolean
}

export function EmailPreview({ subject, body, editable, onSubjectChange, onBodyChange, loading }: Props) {
  if (loading) {
    return (
      <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-6 text-xs text-slate-500 text-center">
        Generating draft from the email template…
      </div>
    )
  }

  if (editable) {
    return (
      <div className="space-y-2">
        <input
          type="text"
          value={subject}
          onChange={(e) => onSubjectChange?.(e.target.value)}
          placeholder="Subject"
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg font-medium focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <textarea
          value={body}
          onChange={(e) => onBodyChange?.(e.target.value)}
          rows={10}
          placeholder="Body"
          className="w-full px-3 py-2.5 text-sm border border-slate-200 rounded-lg leading-relaxed font-sans focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/50 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-slate-100 bg-white text-sm font-semibold text-slate-900">
        {subject || <span className="text-slate-400 italic">No subject</span>}
      </div>
      <div className="px-4 py-3 text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
        {body || <span className="text-slate-400 italic">No body</span>}
      </div>
    </div>
  )
}
