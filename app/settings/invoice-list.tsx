'use client'

import { useState } from 'react'
import { ExternalLink, Download } from 'lucide-react'

/**
 * Spec 24b — Invoice list + Manage billing button in Settings.
 *
 * Each invoice links to:
 *   • [View] — Stripe's hosted invoice page (opens in new tab)
 *   • [Download PDF] — direct PDF download from Stripe
 *
 * The "Manage billing →" button opens the Stripe Customer Portal
 * where the customer can update payment methods, see full history,
 * and pay failed invoices.
 */

export interface InvoiceSummary {
  id: string
  number: string | null
  periodLabel: string
  amountDueCents: number
  amountPaidCents: number
  currency: string
  status: string
  createdAt: string  // ISO string (server-serialized)
  hostedInvoiceUrl: string | null
  invoicePdfUrl: string | null
}

interface Props {
  invoices: InvoiceSummary[]
  /** Whether the customer has a platform customer id (can open portal) */
  hasBillingAccount: boolean
}

function formatMoney(cents: number, currency: string): string {
  // Pin the locale to avoid SSR/CSR hydration mismatches: Node's default
  // locale (en-US) and the browser's default (often en-GB / user locale)
  // render USD differently — "US$99.00" vs "$99.00".
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  })
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; classes: string }> = {
    paid:          { label: 'Paid',          classes: 'bg-green-50 text-green-700 border-green-200' },
    open:          { label: 'Unpaid',        classes: 'bg-amber-50 text-amber-700 border-amber-200' },
    uncollectible: { label: 'Uncollectible', classes: 'bg-slate-100 text-slate-500 border-slate-200' },
    void:          { label: 'Void',          classes: 'bg-slate-100 text-slate-500 border-slate-200' },
    draft:         { label: 'Draft',         classes: 'bg-slate-100 text-slate-500 border-slate-200' },
  }
  const c = config[status] ?? { label: status, classes: 'bg-slate-100 text-slate-500 border-slate-200' }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${c.classes}`}>
      {c.label}
    </span>
  )
}

export function InvoiceList({ invoices, hasBillingAccount }: Props) {
  const [portalLoading, setPortalLoading] = useState(false)
  const [portalError, setPortalError] = useState<string | null>(null)

  async function openPortal() {
    setPortalError(null)
    setPortalLoading(true)
    try {
      const res = await fetch('/api/billing/portal-session', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Failed (${res.status})`)
      }
      const { url } = await res.json()
      if (!url) throw new Error('No portal URL returned')
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      setPortalError(e instanceof Error ? e.message : String(e))
    } finally {
      setPortalLoading(false)
    }
  }

  return (
    <div>
      {invoices.length === 0 ? (
        <div className="text-sm text-slate-500 py-3">
          No invoices yet. We&apos;ll bill you monthly once recoveries are in.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-3">Period</th>
                <th className="py-2 pr-3">Amount</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map(inv => (
                <tr key={inv.id} className="border-b border-slate-50 last:border-b-0">
                  <td className="py-3 pr-3 text-slate-900">{inv.periodLabel}</td>
                  <td className="py-3 pr-3 text-slate-900 font-medium">
                    {formatMoney(inv.amountDueCents, inv.currency)}
                  </td>
                  <td className="py-3 pr-3">
                    <StatusBadge status={inv.status} />
                  </td>
                  <td className="py-3 text-right whitespace-nowrap">
                    {inv.hostedInvoiceUrl && (
                      <a
                        href={inv.hostedInvoiceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-blue-600 hover:underline mr-3 text-xs"
                      >
                        <ExternalLink className="w-3 h-3" /> View
                      </a>
                    )}
                    {inv.invoicePdfUrl && (
                      <a
                        href={inv.invoicePdfUrl}
                        className="inline-flex items-center gap-1 text-slate-600 hover:underline text-xs"
                      >
                        <Download className="w-3 h-3" /> PDF
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasBillingAccount && (
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-xs text-slate-500">
            Manage payment methods, billing address, and full invoice history.
          </p>
          <button
            onClick={openPortal}
            disabled={portalLoading}
            className="self-start sm:self-auto border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {portalLoading ? 'Opening…' : 'Manage billing →'}
          </button>
        </div>
      )}

      {portalError && (
        <p className="text-xs text-red-600 mt-2">{portalError}</p>
      )}
    </div>
  )
}
