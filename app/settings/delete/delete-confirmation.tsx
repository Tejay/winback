'use client'

import { useEffect, useState } from 'react'
import { signOut } from 'next-auth/react'
import { confirmationMatches } from '@/src/winback/lib/workspace'

interface DeleteConfirmationProps {
  workspaceName: string
}

export function DeleteConfirmation({ workspaceName }: DeleteConfirmationProps) {
  const [revealed, setRevealed] = useState(false)
  const [typed, setTyped] = useState('')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const matches = confirmationMatches(typed, workspaceName)
  const arming = countdown !== null

  useEffect(() => {
    if (countdown === null) return
    if (countdown === 0) {
      ;(async () => {
        try {
          const res = await fetch('/api/settings/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: typed }),
          })
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            setError(j.error ?? 'Deletion failed')
            setCountdown(null)
            return
          }
          // Sign out — wipes session + redirects to landing
          await signOut({ callbackUrl: '/' })
        } catch {
          setError('Network error. Please try again.')
          setCountdown(null)
        }
      })()
      return
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000)
    return () => clearTimeout(t)
  }, [countdown, typed])

  if (!revealed) {
    return (
      <div className="mt-8 flex items-center gap-3">
        <button
          onClick={() => setRevealed(true)}
          className="bg-rose-600 text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-rose-700"
        >
          Continue to deletion &rarr;
        </button>
        <a
          href="/settings"
          className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Cancel, take me back
        </a>
      </div>
    )
  }

  return (
    <div className="mt-8 border-t border-rose-100 pt-8">
      <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">
        Type your workspace name to confirm deletion
      </label>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        disabled={arming}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full font-mono focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:bg-slate-50"
        placeholder={workspaceName}
      />
      <p className="text-xs text-slate-500 mt-2">
        Your workspace name is:{' '}
        <code className="bg-slate-100 text-slate-900 px-1.5 py-0.5 rounded font-mono">
          {workspaceName}
        </code>
      </p>

      {error && (
        <p className="text-xs text-rose-600 mt-3">{error}</p>
      )}

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={() => setCountdown(3)}
          disabled={!matches || arming}
          className={`rounded-full px-6 py-2.5 text-sm font-medium ${
            matches && !arming
              ? 'bg-rose-600 text-white hover:bg-rose-700'
              : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }`}
        >
          {arming
            ? countdown === 0
              ? 'Deleting…'
              : `Deleting in ${countdown}…`
            : 'Permanently delete workspace'}
        </button>
        {!arming && (
          <a
            href="/settings"
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Cancel
          </a>
        )}
      </div>
    </div>
  )
}
