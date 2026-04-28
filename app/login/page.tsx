'use client'

import { Suspense, useState } from 'react'
import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Logo } from '@/components/logo'
import { loginAction } from './actions'

function LoginForm() {
  const searchParams = useSearchParams()
  const justReset = searchParams.get('reset') === '1'
  const initialError = searchParams.get('error') === '1'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError ? 'Invalid email or password.' : '')
  const [loading, setLoading] = useState(false)

  // The form's `action={loginAction}` works even before React hydrates —
  // Next.js's server-action transport handles native form POSTs to a
  // generated endpoint. When JS IS hydrated, this onSubmit intercepts and
  // uses next-auth/react's signIn() for a no-full-nav UX.
  async function onFormSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    setError('')
    setLoading(true)

    const res = await signIn('credentials', {
      email,
      password,
      redirect: false,
    })

    setLoading(false)

    if (res?.error) {
      setError('Invalid email or password.')
    } else {
      window.location.href = '/dashboard'
    }
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center">
      <div className="mt-12 mb-8">
        <Logo />
      </div>

      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">
          Welcome back.
        </h1>
        <p className="text-sm text-slate-500 mb-8">
          Let&apos;s recover some revenue.
        </p>

        {justReset && (
          <div className="mb-6 bg-green-50 text-green-700 border border-green-200 rounded-lg px-4 py-2.5 text-sm">
            Password updated. Sign in with your new password.
          </div>
        )}

        <form action={loginAction} onSubmit={onFormSubmit} className="space-y-4">
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

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500">
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-xs text-blue-600 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
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
            {loading ? 'Logging in...' : 'Log in →'}
          </button>

          {error && (
            <p className="text-sm text-red-600 text-center mt-2">{error}</p>
          )}
        </form>

        <p className="text-sm text-slate-500 text-center mt-6">
          Don&apos;t have an account?{' '}
          <Link href="/register" className="text-blue-600 font-medium">
            Sign up
          </Link>
        </p>
      </div>

      <nav className="mt-8 mb-12 flex items-center gap-4 text-xs text-slate-400">
        <Link href="/privacy" className="hover:text-slate-700">Privacy</Link>
        <span>·</span>
        <Link href="/terms" className="hover:text-slate-700">Terms</Link>
        <span>·</span>
        <Link href="/dpa" className="hover:text-slate-700">DPA</Link>
      </nav>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  )
}
