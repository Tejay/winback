'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function ApproveButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleApprove() {
    setLoading(true)
    await fetch('/api/customers/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboardingComplete: true }),
    })
    router.push('/dashboard')
  }

  return (
    <button
      onClick={handleApprove}
      disabled={loading}
      className={`rounded-full px-5 py-2 text-sm font-medium ${
        loading
          ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
          : 'bg-[#0f172a] text-white hover:bg-[#1e293b]'
      }`}
    >
      {loading ? 'Setting up...' : 'Approve & enter dashboard →'}
    </button>
  )
}
