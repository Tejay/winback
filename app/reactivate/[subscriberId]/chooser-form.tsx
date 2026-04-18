'use client'

import { useState } from 'react'

interface PriceOption {
  id: string
  productName: string
  unitAmount: number | null
  currency: string
  interval: string | null
  isPrevious: boolean
}

function formatPrice(unitAmount: number | null, currency: string, interval: string | null): string {
  if (unitAmount === null) return 'Custom'
  const amount = (unitAmount / 100).toLocaleString(undefined, {
    style: 'currency',
    currency: currency.toUpperCase(),
  })
  return interval ? `${amount}/${interval}` : amount
}

export function ChooserForm({
  subscriberId,
  token,
  options,
}: {
  subscriberId: string
  token: string
  options: PriceOption[]
}) {
  const [selected, setSelected] = useState<string>(options[0]?.id ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit() {
    if (!selected) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/reactivate/${subscriberId}/checkout?t=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId: selected }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Request failed (${res.status})`)
      }
      const data = await res.json()
      if (!data.url) throw new Error('No checkout URL returned')
      window.location.href = data.url
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3">
      {options.map(opt => (
        <label
          key={opt.id}
          className={`flex items-start gap-3 border rounded-xl p-4 cursor-pointer transition-colors ${
            selected === opt.id
              ? 'border-blue-500 bg-blue-50'
              : 'border-slate-200 bg-white hover:border-slate-300'
          }`}
        >
          <input
            type="radio"
            name="price"
            value={opt.id}
            checked={selected === opt.id}
            onChange={() => setSelected(opt.id)}
            className="mt-1"
          />
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-900">{opt.productName}</span>
              {opt.isPrevious && (
                <span className="text-xs font-semibold text-blue-700 bg-blue-100 rounded-full px-2 py-0.5">
                  Your previous plan
                </span>
              )}
            </div>
            <div className="text-sm text-slate-600 mt-1">
              {formatPrice(opt.unitAmount, opt.currency, opt.interval)}
            </div>
          </div>
        </label>
      ))}

      {error && (
        <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800">
          {error}
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={!selected || submitting}
        className="w-full bg-[#0f172a] text-white rounded-full py-3 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-300 disabled:cursor-not-allowed"
      >
        {submitting ? 'Opening checkout…' : 'Continue to payment'}
      </button>
    </div>
  )
}
