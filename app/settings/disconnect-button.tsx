'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface DisconnectButtonProps {
  service: 'stripe' | 'gmail'
}

export function DisconnectButton({ service }: DisconnectButtonProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${service === 'stripe' ? 'Stripe' : 'Gmail'}? You can reconnect anytime.`)) return

    setLoading(true)
    await fetch(`/api/${service}/disconnect`, { method: 'POST' })
    router.refresh()
    setLoading(false)
  }

  return (
    <button
      onClick={handleDisconnect}
      disabled={loading}
      className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
    >
      {loading ? 'Disconnecting...' : 'Disconnect'}
    </button>
  )
}
