'use client'

import { useState } from 'react'
import Link from 'next/link'

export function ForgotPasswordForm({
  initialSubmitted,
}: {
  initialSubmitted: boolean
}) {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(initialSubmitted)
  const [loading, setLoading] = useState(false)

  // The form has a real `action` and the email input has a `name` so a
  // native HTML POST works without JS at all (the API redirects to
  // ?submitted=1, which is what `initialSubmitted` reflects). When JS IS
  // available, this onSubmit handler intercepts and uses fetch for a
  // smoother UX (no full nav).
  async function onFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    } finally {
      setLoading(false)
      setSubmitted(true)
    }
  }

  if (submitted) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          If an account exists for that email, we&apos;ve sent a reset link.
          Check your inbox (and spam folder). The link expires in 24 hours.
        </p>
        <button
          type="button"
          onClick={() => setSubmitted(false)}
          className="block text-center w-full rounded-full px-5 py-2.5 text-sm font-medium bg-[#0f172a] text-white hover:bg-[#1e293b]"
        >
          Send another link
        </button>
        <Link
          href="/login"
          className="block text-center w-full rounded-full px-5 py-2.5 text-sm font-medium border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        >
          Back to sign in
        </Link>
      </div>
    )
  }

  return (
    <form
      action="/api/auth/forgot-password"
      method="POST"
      onSubmit={onFormSubmit}
      className="space-y-4"
    >
      <div>
        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          Email
        </label>
        <input
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          required
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
        {loading ? 'Sending...' : 'Send reset link'}
      </button>

      <p className="text-sm text-slate-500 text-center mt-6">
        <Link href="/login" className="text-blue-600 font-medium">
          Back to sign in
        </Link>
      </p>
    </form>
  )
}
