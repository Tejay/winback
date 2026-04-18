'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Spec 21c — Notification email setting.
 * Lets the founder route Winback alerts (handoff, post-handoff replies,
 * changelog matches) to a different inbox than their signin email.
 */
export function NotificationEmailForm({
  initial,
  fallbackEmail,
}: {
  initial: string | null
  fallbackEmail: string | null
}) {
  const router = useRouter()
  const [value, setValue] = useState(initial ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const res = await fetch('/api/settings/notification-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationEmail: value.trim() || null }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Failed (${res.status})`)
      }
      setSavedAt(Date.now())
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const showSaved = savedAt && Date.now() - savedAt < 3000
  const dirty = (value.trim() || null) !== initial

  return (
    <div className="py-2">
      <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
        Notification email
      </label>
      <div className="flex gap-2">
        <input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={fallbackEmail ?? 'team@yourcompany.com'}
          className="flex-1 border border-slate-200 rounded-full px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-300 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Where we send handoff alerts and subscriber updates. Defaults to{' '}
        <span className="font-mono">{fallbackEmail ?? 'your signin email'}</span> if blank.
      </p>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      {showSaved && <p className="text-xs text-green-600 mt-2">Saved ✓</p>}
    </div>
  )
}
