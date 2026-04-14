'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Logo } from '@/components/logo'

export default function RegisterPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    if (!accepted) {
      setError('Please accept the Terms, Privacy Policy, and Data Processing Agreement.')
      return
    }

    setLoading(true)

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, acceptedLegal: accepted }),
    })

    const data = await res.json()
    setLoading(false)

    if (!res.ok) {
      if (res.status === 409) {
        setError('An account with this email already exists.')
      } else {
        setError(data.error || 'Something went wrong.')
      }
      return
    }

    router.push('/login')
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center">
      <div className="mt-12 mb-8">
        <Logo />
      </div>

      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">
          Create your account.
        </h1>
        <p className="text-sm text-slate-500 mb-8">
          Connect Stripe and start recovering churn in under 5 minutes.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
              Your name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alex Founder"
              required
              className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
              Work email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
              className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
              className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <label className="flex items-start gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5"
              required
            />
            <span>
              I accept the{' '}
              <Link href="/terms" className="text-blue-600 underline" target="_blank">Terms</Link>,{' '}
              <Link href="/privacy" className="text-blue-600 underline" target="_blank">Privacy Policy</Link>, and{' '}
              <Link href="/dpa" className="text-blue-600 underline" target="_blank">Data Processing Agreement</Link>.
            </span>
          </label>

          <button
            type="submit"
            disabled={loading || !accepted}
            className={`w-full rounded-full px-5 py-2.5 text-sm font-medium ${
              loading || !accepted
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-[#0f172a] text-white hover:bg-[#1e293b]'
            }`}
          >
            {loading ? 'Creating account...' : 'Create account →'}
          </button>

          <p className="text-xs text-blue-600 text-center mt-2">
            Free until your first recovery. No card required.
          </p>

          {error && (
            <p className="text-sm text-red-600 text-center mt-2">{error}</p>
          )}
        </form>

        <p className="text-sm text-slate-500 text-center mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-blue-600 font-medium">
            Log in
          </Link>
        </p>
      </div>
    </div>
  )
}
