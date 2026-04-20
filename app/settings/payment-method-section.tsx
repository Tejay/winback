'use client'

import { useState } from 'react'
import { CreditCard } from 'lucide-react'

/**
 * Spec 23 — Payment method section in Settings.
 *
 * Two states:
 *   • No PM yet → "Add payment method" button
 *   • PM captured → "Visa •••• 4242 · exp 12/2030" with [Update] button
 *
 * Both states POST to /api/billing/setup-intent which returns a Stripe
 * Checkout URL; we redirect the browser. The webhook handles attaching
 * the PM after Checkout completes.
 */

interface PaymentMethodSummary {
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

interface Props {
  paymentMethod: PaymentMethodSummary | null
  billingStatus: 'success' | 'cancelled' | null
}

function brandLabel(brand: string): string {
  const lower = brand.toLowerCase()
  if (lower === 'visa') return 'Visa'
  if (lower === 'mastercard') return 'Mastercard'
  if (lower === 'amex') return 'Amex'
  if (lower === 'discover') return 'Discover'
  return brand.charAt(0).toUpperCase() + brand.slice(1)
}

export function PaymentMethodSection({ paymentMethod, billingStatus }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function startSetup() {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/billing/setup-intent', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Failed (${res.status})`)
      }
      const { url } = await res.json()
      if (!url) throw new Error('No checkout URL returned')
      window.location.href = url
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Status banner */}
      {billingStatus === 'success' && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800">
          ✓ Payment method saved
        </div>
      )}
      {billingStatus === 'cancelled' && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          Setup cancelled — your card wasn&apos;t saved
        </div>
      )}

      {paymentMethod ? (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3">
          <div className="flex items-center gap-3">
            <div className="bg-slate-100 rounded-lg w-10 h-10 flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-slate-600" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">
                {brandLabel(paymentMethod.brand)} •••• {paymentMethod.last4}
              </div>
              <div className="text-xs text-slate-500">
                Expires {String(paymentMethod.expMonth).padStart(2, '0')}/{paymentMethod.expYear}
              </div>
            </div>
          </div>
          <button
            onClick={startSetup}
            disabled={loading}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Opening…' : 'Update'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-3">
          <div className="text-sm text-slate-500">
            No payment method on file yet.
          </div>
          <button
            onClick={startSetup}
            disabled={loading}
            className="bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-300 disabled:cursor-not-allowed"
          >
            {loading ? 'Opening…' : 'Add payment method'}
          </button>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-600 mt-2">{error}</p>
      )}
    </div>
  )
}
