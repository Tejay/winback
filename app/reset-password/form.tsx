'use client'

import { useState } from 'react'

export function ResetPasswordForm({
  token,
  initialError,
}: {
  token: string
  initialError?: string | null
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(initialError ?? '')
  const [loading, setLoading] = useState(false)

  // The form has a real `action` and `method`, with `name` attributes on
  // every input. So a native HTML POST works without JS at all — the API
  // accepts form-encoded bodies and 303-redirects to /login?reset=1 on
  // success (or back here with ?pwError=… on failure). When JS hydrates,
  // this onSubmit intercepts and uses fetch for a smoother UX (no full
  // page navigation).
  async function onFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    })

    if (!res.ok) {
      setLoading(false)
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Could not update password. Try again.')
      return
    }

    // .replace() so the now-invalid /reset-password URL doesn't sit in
    // history — pressing back from /login would otherwise re-render the
    // consumed-token page and look like the reset failed.
    window.location.replace('/login?reset=1')
  }

  return (
    <form
      action="/api/auth/reset-password"
      method="POST"
      onSubmit={onFormSubmit}
      className="space-y-4"
    >
      <input type="hidden" name="token" value={token} />

      <div>
        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          New password
        </label>
        <input
          type="password"
          name="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
          minLength={8}
          className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          Confirm password
        </label>
        <input
          type="password"
          name="confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
          required
          minLength={8}
          className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={loading}
        className={`w-full rounded-full px-5 py-2.5 text-sm font-medium ${
          loading
            ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
            : 'bg-[#0f172a] text-white hover:bg-[#1e293b]'
        }`}
      >
        {loading ? 'Updating...' : 'Update password'}
      </button>

      {error && (
        <p className="text-sm text-red-600 text-center mt-2">{error}</p>
      )}
    </form>
  )
}
