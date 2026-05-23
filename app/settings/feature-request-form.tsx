'use client'

import { useState } from 'react'

/**
 * Settings → Feature requests submit form. Renders inside the
 * collapsible <details> section on the settings page. Submits to
 * /api/settings/feature-requests; success state shows a 5s confirmation
 * mirroring the "we'll email you if we ship it" promise (mechanism
 * deferred — see migration 052 + the dormant shipped_at column).
 */
export function FeatureRequestForm() {
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submittedAt, setSubmittedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/settings/feature-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Failed (${res.status})`)
      }
      setSubmittedAt(Date.now())
      setText('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const recentlySubmitted = submittedAt && Date.now() - submittedAt < 5000
  const canSubmit = text.trim().length > 0 && !submitting

  return (
    <div className="mt-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What's missing or what would make this better?"
        rows={4}
        maxLength={4000}
        className="w-full border border-slate-200 rounded-2xl px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-slate-500">
          Prefer email?{' '}
          <a
            href="mailto:features@winbackflow.co"
            className="text-blue-600 hover:underline"
          >
            features@winbackflow.co
          </a>
        </p>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          {submitting ? 'Sending…' : 'Send'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {recentlySubmitted && (
        <p className="text-xs text-green-600 mt-2">
          Thanks — we got it. We&rsquo;ll email you if we ship it.
        </p>
      )}
    </div>
  )
}
