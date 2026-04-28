'use client'

import { useState } from 'react'

export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function submit() {
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

    // Full navigation rather than router.push — soft navigation re-renders
    // the /reset-password server component during transition, which would
    // re-run validateResetToken on the now-consumed token and flash the
    // "Link no longer valid" view before /login paints.
    //
    // .replace() instead of .href so the now-invalid /reset-password URL
    // doesn't sit in history — pressing back from /login would otherwise
    // re-render the consumed-token page and look like the reset failed.
    window.location.replace('/login?reset=1')
  }

  function onFormSubmit(e: React.FormEvent) {
    // Belt-and-braces: this only fires once React has hydrated, but in the
    // pre-hydration window the button below is type="button" so a native
    // submit can't happen at all. Both paths converge on submit().
    e.preventDefault()
    submit()
  }

  return (
    // No `action` attribute — and the button is type="button" — so even
    // before React hydrates, clicking "Update password" can never trigger
    // a native form GET that would strip ?token=… from the URL.
    <form onSubmit={onFormSubmit} className="space-y-4" noValidate>
      <div>
        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          New password
        </label>
        <input
          type="password"
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
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="••••••••"
          required
          minLength={8}
          className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        type="button"
        onClick={submit}
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
