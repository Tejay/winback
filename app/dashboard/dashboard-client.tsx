'use client'

import { useState, useEffect, useCallback } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { TrendingUp, CheckCircle, DollarSign, Users, Search, Zap, X, RotateCcw, Check } from 'lucide-react'

interface Subscriber {
  id: string
  name: string | null
  email: string | null
  planName: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  cancellationCategory: string | null
  status: string
  mrrCents: number
  tenureDays: number | null
  stripeComment: string | null
  replyText: string | null
  triggerKeyword: string | null
  tier: number | null
  confidence: string | null
  winBackSubject: string | null
  winBackBody: string | null
  attributionType: string | null
}

interface Stats {
  recoveryRate: number
  recovered: number
  mrrRecoveredCents: number
  atRisk: number
}

interface DashboardClientProps {
  changelog: string
  isTrial: boolean
  firstRecovery: { name: string | null; mrrCents: number } | null
}

export function DashboardClient({ changelog, isTrial, firstRecovery }: DashboardClientProps) {
  const [stats, setStats] = useState<Stats>({ recoveryRate: 0, recovered: 0, mrrRecoveredCents: 0, atRisk: 0 })
  const [subscribers, setSubscribers] = useState<Subscriber[]>([])
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Subscriber | null>(null)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogText, setChangelogText] = useState(changelog)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  useEffect(() => {
    const dismissed = localStorage.getItem('winback_banner_dismissed')
    if (dismissed) setBannerDismissed(true)
  }, [])

  const fetchData = useCallback(() => {
    fetch('/api/stats').then((r) => r.json()).then(setStats)
    const params = new URLSearchParams()
    if (filter !== 'all') params.set('filter', filter)
    if (search) params.set('search', search)
    fetch(`/api/subscribers?${params}`).then((r) => r.json()).then(setSubscribers)
  }, [filter, search])

  useEffect(() => { fetchData() }, [fetchData])

  function dismissBanner() {
    setBannerDismissed(true)
    localStorage.setItem('winback_banner_dismissed', 'true')
  }

  async function saveChangelog() {
    await fetch('/api/changelog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: changelogText }),
    })
    setChangelogOpen(false)
  }

  async function handleAction(id: string, action: 'resend' | 'recover') {
    await fetch(`/api/subscribers/${id}/${action}`, { method: 'POST' })
    setSelected(null)
    fetchData()
  }

  const filters = ['all', 'pending', 'contacted', 'recovered', 'lost']
  const showBanner = isTrial && firstRecovery && !bannerDismissed

  return (
    <>
      {/* Page header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">Overview</div>
          <h1 className="text-4xl font-bold text-slate-900">Dashboard.</h1>
          <p className="text-sm text-slate-500 mt-1">Every cancellation, every recovery — all in one view.</p>
        </div>
        <button
          onClick={() => setChangelogOpen(true)}
          className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
        >
          Update changelog
        </button>
      </div>

      {/* Billing alert */}
      {showBanner && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="bg-blue-50 rounded-full p-2 flex-shrink-0">
              <Zap className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-900">
                🎉 Your first recovery is in{firstRecovery.name ? ` — ${firstRecovery.name} is back` : ''} at ${(firstRecovery.mrrCents / 100).toFixed(0)}/mo.
              </p>
              <p className="text-sm text-slate-600 mt-1">
                Add a payment method to keep recovering. Billing is{' '}
                <strong>15% of recovered revenue</strong> for 12 months per subscriber. No base fee.
              </p>
              <div className="mt-3 flex items-center gap-4">
                <a href="/settings#billing" className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]">
                  Add billing to keep recovering
                </a>
                <button onClick={dismissBanner} className="text-sm text-slate-400 hover:text-slate-600">Not now</button>
              </div>
            </div>
          </div>
          <button onClick={dismissBanner} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-green-50 rounded-xl w-9 h-9 flex items-center justify-center text-green-600">
            <TrendingUp className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">{stats.recoveryRate}%</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">Recovery Rate</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-green-50 rounded-xl w-9 h-9 flex items-center justify-center text-green-600">
            <CheckCircle className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">{stats.recovered}</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">Recovered</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-green-50 rounded-xl w-9 h-9 flex items-center justify-center text-green-600">
            <DollarSign className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">${Math.round(stats.mrrRecoveredCents / 100)}</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">MRR Recovered</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-amber-50 rounded-xl w-9 h-9 flex items-center justify-center text-amber-600">
            <Users className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">{stats.atRisk}</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">At Risk</div>
        </div>
      </div>

      {/* Filter tabs + search */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1">
          {filters.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                filter === f
                  ? 'bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium'
                  : 'text-slate-500 hover:text-slate-900 rounded-full px-4 py-1.5 text-sm font-medium transition-colors'
              }
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search name, email, reason"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-slate-200 rounded-full px-4 py-2 text-sm w-64 pl-10 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Subscriber table */}
      <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Subscriber</th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Plan</th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Cancelled</th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Reason</th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Status</th>
              <th className="text-right text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">MRR</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((sub) => (
              <tr
                key={sub.id}
                onClick={() => setSelected(sub)}
                className="hover:bg-slate-50 cursor-pointer border-b border-slate-50 transition-colors"
              >
                <td className="py-4 pr-4 px-4">
                  <div className="text-sm font-medium text-slate-900">{sub.name ?? 'Unknown'}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{sub.email ?? ''}</div>
                </td>
                <td className="text-sm text-slate-600 py-4 px-4">{sub.planName ?? '—'}</td>
                <td className="text-sm text-slate-600 py-4 px-4">
                  {sub.cancelledAt ? new Date(sub.cancelledAt).toISOString().split('T')[0] : '—'}
                </td>
                <td className="text-sm text-slate-600 py-4 px-4">
                  {sub.cancellationReason
                    ? sub.cancellationReason.length > 45
                      ? sub.cancellationReason.slice(0, 45) + '…'
                      : sub.cancellationReason
                    : '—'}
                </td>
                <td className="py-4 px-4">
                  <StatusBadge status={sub.status as 'pending' | 'contacted' | 'recovered' | 'lost'} />
                </td>
                <td className="text-sm font-medium text-slate-900 py-4 px-4 text-right">
                  ${(sub.mrrCents / 100).toFixed(2)}
                </td>
              </tr>
            ))}
            {subscribers.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center py-12 text-sm text-slate-400">
                  No subscribers found. They&apos;ll appear here when cancellations come in from Stripe.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Subscriber detail panel */}
      {selected && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setSelected(null)} />
          <div className="fixed right-0 top-0 h-full w-96 bg-white shadow-xl border-l border-slate-100 z-50 overflow-y-auto">
            <div className="px-6 pt-6 pb-4 border-b border-slate-100 flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Subscriber</div>
                <div className="text-xl font-bold text-slate-900">{selected.name ?? 'Unknown'}</div>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusBadge status={selected.status as 'pending' | 'contacted' | 'recovered' | 'lost'} />
                {selected.status === 'recovered' && selected.attributionType && (
                  <span className={`text-xs font-medium ${
                    selected.attributionType === 'strong'
                      ? 'text-green-600'
                      : 'text-blue-600'
                  }`}>
                    {selected.attributionType === 'strong' ? '— via Winback link' : '— resubscribed organically'}
                  </span>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">MRR</div>
                <div className="text-xl font-bold text-slate-900">${(selected.mrrCents / 100).toFixed(2)}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 px-6">
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Email</div>
                <div className="text-sm font-medium text-slate-900 truncate">{selected.email ?? '—'}</div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Plan</div>
                <div className="text-sm font-medium text-slate-900">{selected.planName ?? '—'}</div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Cancelled</div>
                <div className="text-sm font-medium text-slate-900">
                  {selected.cancelledAt ? new Date(selected.cancelledAt).toISOString().split('T')[0] : '—'}
                </div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Tenure</div>
                <div className="text-sm font-medium text-slate-900">
                  {selected.tenureDays != null
                    ? selected.tenureDays >= 30
                      ? `${Math.round(selected.tenureDays / 30)} months`
                      : `${selected.tenureDays} days`
                    : '—'}
                </div>
              </div>
            </div>

            {selected.cancellationReason && (
              <div className="mx-6 mt-4 bg-blue-50 rounded-xl p-4">
                <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">Cancellation Reason</div>
                <div className="text-sm font-medium text-slate-900 italic mb-1">{selected.cancellationReason}</div>
                {selected.cancellationCategory && (
                  <div className="text-xs text-slate-400">Category: {selected.cancellationCategory}</div>
                )}
              </div>
            )}

            <div className="px-6 mt-5">
              <div className="text-sm font-semibold text-slate-900 mb-3">Email history</div>
              <p className="text-sm text-slate-400">
                No emails sent yet. Winback will send the first one automatically.
              </p>
            </div>

            <div className="px-6 mt-5 pt-5 border-t border-slate-100 pb-6">
              {selected.status !== 'recovered' && selected.status !== 'lost' && (
                <div className="flex gap-3 mb-3">
                  <button
                    onClick={() => handleAction(selected.id, 'resend')}
                    className="flex-1 border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-2 text-sm font-medium flex items-center justify-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Resend
                  </button>
                  <button
                    onClick={() => handleAction(selected.id, 'recover')}
                    className="flex-1 bg-[#0f172a] text-white rounded-full px-4 py-2 text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-[#1e293b]"
                  >
                    <Check className="w-3.5 h-3.5" /> Mark recovered
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Changelog modal */}
      {changelogOpen && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setChangelogOpen(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-xl p-8 w-full max-w-lg">
              <h2 className="text-xl font-bold text-slate-900 mb-2">Update changelog</h2>
              <p className="text-sm text-slate-500 mb-4">Paste your latest improvements. Winback uses this to write specific win-back messages.</p>
              <textarea
                value={changelogText}
                onChange={(e) => setChangelogText(e.target.value)}
                placeholder="e.g.&#10;- Fixed the calendar sync bug&#10;- Added CSV export for all reports"
                className="min-h-[200px] w-full border border-slate-200 rounded-2xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <div className="flex justify-end gap-3 mt-4">
                <button
                  onClick={() => setChangelogOpen(false)}
                  className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={saveChangelog}
                  className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
