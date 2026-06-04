'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

interface Detail {
  identity: {
    id: string
    userId: string
    email: string
    founderName: string | null
    productName: string | null
    notificationEmail: string | null
    plan: string | null
    pausedAt: string | null
    stripeAccountId: string | null
    stripeConnected: boolean
    stripePlatformCustomerId: string | null
    createdAt: string
    // Spec 77 — non-null when this customer is on a negotiated flat-rate
    // deal. Drives the "Custom pricing" admin section below.
    customMonthlyCents: number | null
    // PR B — header support context.
    billedTier: string | null
    activatedAt: string | null
    stripeSubscriptionId: string | null
  }
  stripeHealth: {
    lastActivityAt: string | null
    recentOauthErrors: number
  }
  recentEmails: Array<{
    id: string
    type: string
    subject: string | null
    sentAt: string
    repliedAt: string | null
    subscriberId: string
    subscriberEmail: string | null
    subscriberName: string | null
  }>
  recentEvents: Array<{
    id: string
    name: string
    properties: Record<string, unknown>
    createdAt: string
  }>
  billing: {
    outstandingObligations: number
  }
  openHandoffs: number
  subscriberCount: number
}

type Tab = 'overview' | 'emails' | 'events' | 'billing'

const TIER_LABELS: Record<string, string> = {
  starter: 'Starter', growth: 'Growth', scale: 'Scale', enterprise: 'Enterprise', custom: 'Custom',
}

export function CustomerDetailClient({ customerId }: { customerId: string }) {
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [showImpersonate, setShowImpersonate] = useState(false)
  const [tab, setTab] = useState<Tab>('overview')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(`/api/admin/customers/${customerId}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [customerId])

  useEffect(() => { load() }, [load])

  async function action(name: string, body: Record<string, unknown>, label: string) {
    setBusy(name)
    setActionMsg(null)
    try {
      const res = await fetch(`/api/admin/actions/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customerId, ...body }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `${label} failed`)
      setActionMsg(`✓ ${label}`)
      await load()
    } catch (e) {
      setActionMsg(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  if (error && !data) return <ErrorPanel error={error} />
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>

  const id = data.identity

  const paused = !!id.pausedAt
  const tierLabel = id.customMonthlyCents !== null
    ? 'Custom'
    : id.billedTier ? (TIER_LABELS[id.billedTier] ?? id.billedTier) : null

  const TABS: Array<{ key: Tab; label: string; badge?: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'emails',   label: 'Emails',  badge: data.recentEmails.length ? String(data.recentEmails.length) : undefined },
    { key: 'events',   label: 'Events',  badge: data.recentEvents.length ? String(data.recentEvents.length) : undefined },
    { key: 'billing',  label: 'Billing' },
  ]

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <div className="text-xs text-slate-500">
        <Link href="/admin/customers" className="hover:text-slate-700">Customers</Link>
        <span className="text-slate-300"> / </span>
        <span className="text-slate-700 font-medium">{id.founderName ?? id.productName ?? id.email}</span>
      </div>

      {/* Sticky header: identity + badges + actions, always visible across tabs */}
      <header className="bg-white rounded-2xl border border-slate-200 p-5 sticky top-2 z-20">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900 truncate">
              {id.founderName ?? id.email}
              {id.productName && <span className="ml-2 text-base font-normal text-slate-500">· {id.productName}</span>}
            </h1>
            <div className="text-sm text-slate-500 font-mono">{id.email}</div>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <Badge tone={id.plan === 'paid' ? 'green' : 'slate'}>{id.plan ?? 'trial'}</Badge>
              {tierLabel && <Badge tone="blue">{tierLabel}{id.customMonthlyCents !== null ? ` $${(id.customMonthlyCents / 100).toFixed(0)}/mo` : ''}</Badge>}
              <Badge tone={id.stripeConnected ? 'green' : 'red'}>{id.stripeConnected ? '✓ Stripe' : '✗ Stripe'}</Badge>
              {id.activatedAt && <Badge tone="slate">activated</Badge>}
              {paused && <Badge tone="amber">⏸ paused</Badge>}
              {data.openHandoffs > 0 && <Badge tone="amber">{data.openHandoffs} open handoff{data.openHandoffs === 1 ? '' : 's'}</Badge>}
              {data.stripeHealth.recentOauthErrors > 0 && <Badge tone="red">{data.stripeHealth.recentOauthErrors} OAuth err (7d)</Badge>}
              <Link href={`/admin/subscribers?customerId=${id.id}`} className="text-xs text-blue-600 hover:underline ml-1">
                {data.subscriberCount} subscriber{data.subscriberCount === 1 ? '' : 's'} →
              </Link>
            </div>
          </div>

          {/* Action buttons — always reachable, no scrolling mid-incident */}
          <div className="flex flex-wrap gap-1.5 shrink-0">
            <ActionButton
              onClick={() => action('pause-customer', { paused: !id.pausedAt }, id.pausedAt ? 'Resumed sending' : 'Paused all sending')}
              disabled={busy !== null} busy={busy === 'pause-customer'} tone="slate"
            >
              {paused ? 'Resume sending' : 'Pause sending'}
            </ActionButton>
            <ActionButton
              onClick={() => { if (!confirm('Force OAuth reset will clear the customer\'s Stripe access token. They will need to reconnect on next login. Continue?')) return; action('force-oauth-reset', {}, 'OAuth reset') }}
              disabled={busy !== null} busy={busy === 'force-oauth-reset'} tone="amber"
            >
              OAuth reset
            </ActionButton>
            <ActionButton
              onClick={() => { if (data.openHandoffs === 0) return; if (!confirm(`Resolve ${data.openHandoffs} open handoff(s) for this customer?`)) return; action('resolve-handoff', {}, 'Handoffs resolved') }}
              disabled={busy !== null || data.openHandoffs === 0} tone="slate"
            >
              Resolve handoffs{data.openHandoffs > 0 ? ` (${data.openHandoffs})` : ''}
            </ActionButton>
            <ActionButton onClick={() => setShowImpersonate(true)} disabled={busy !== null} tone="red">
              Impersonate
            </ActionButton>
          </div>
        </div>

        {actionMsg && (
          <div className={`text-sm rounded-lg px-3 py-1.5 mt-3 ${
            actionMsg.startsWith('✓')
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}>{actionMsg}</div>
        )}
      </header>

      {/* Tabs */}
      <div className="bg-white border border-slate-200 rounded-full p-0.5 inline-flex text-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded-full font-medium flex items-center gap-1.5 ${
              tab === t.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            {t.label}
            {t.badge && <span className={`text-[10px] rounded-full px-1.5 ${tab === t.key ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{t.badge}</span>}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <div className="space-y-4">
          <Section label="Identity">
            <KV k="Email" v={id.email} />
            <KV k="Notification email" v={id.notificationEmail ?? '(uses signin email)'} />
            <KV k="Plan" v={id.plan ?? 'trial'} />
            <KV k="Tier" v={tierLabel ?? '(no active sub)'} />
            <KV k="Paused" v={id.pausedAt ? `since ${new Date(id.pausedAt).toLocaleString()}` : 'no'} />
            <KV k="Activated" v={id.activatedAt ? new Date(id.activatedAt).toLocaleString() : 'not activated'} />
            <KV k="Created" v={new Date(id.createdAt).toLocaleString()} />
          </Section>

          <Section label="Stripe health">
            <KV k="Account" v={id.stripeAccountId ?? '(not connected)'} />
            <KV k="Token" v={id.stripeConnected ? '✓ present' : '✗ missing/expired'} />
            <KV k="Subscription" v={id.stripeSubscriptionId ?? '(none — not paying)'} />
            <KV k="Last activity" v={data.stripeHealth.lastActivityAt
              ? new Date(data.stripeHealth.lastActivityAt).toLocaleString()
              : 'no events on record'} />
            <KV k="OAuth errors (7d)" v={String(data.stripeHealth.recentOauthErrors)} />
          </Section>
        </div>
      )}

      {tab === 'emails' && (
        <Section label="Recent emails (last 20)">
          {data.recentEmails.length === 0 ? (
            <div className="text-sm text-slate-400 px-4 py-3">No emails yet.</div>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {data.recentEmails.map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2 text-xs text-slate-500 w-20">{relTime(e.sentAt)}</td>
                    <td className="px-4 py-2 text-xs font-mono">{e.type}</td>
                    <td className="px-4 py-2 text-slate-700">{e.subject ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">→ {e.subscriberEmail ?? '?'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {tab === 'events' && (
        <Section label="Recent events (last 50)" rightSlot={
          <Link href={`/admin/events?customer=${id.id}`} className="text-xs text-blue-600 hover:underline">
            view all events →
          </Link>
        }>
          {data.recentEvents.length === 0 ? (
            <div className="text-sm text-slate-400 px-4 py-3">No events yet.</div>
          ) : (
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {data.recentEvents.map((e) => (
                  <tr key={e.id}>
                    <td className="px-4 py-2 text-xs text-slate-500 w-20">{relTime(e.createdAt)}</td>
                    <td className="px-4 py-2 text-xs font-mono text-slate-700">{e.name}</td>
                    <td className="px-4 py-2 text-xs font-mono text-slate-500 truncate max-w-md">
                      {JSON.stringify(e.properties)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {tab === 'billing' && (
        <div className="space-y-4">
          <Section label="Billing snapshot">
            <KV k="Tier" v={tierLabel ?? '(no active sub)'} />
            <KV k="Platform subscription" v={id.stripeSubscriptionId ?? '(none)'} />
            <KV k="Platform Stripe customer" v={id.stripePlatformCustomerId ?? '(no platform card on file)'} />
          </Section>
          <CustomPricingSection
            customerId={customerId}
            currentCents={id.customMonthlyCents}
            onChanged={load}
          />
        </div>
      )}

      {showImpersonate && (
        <ImpersonateModal
          targetUserId={id.userId}
          targetEmail={id.email}
          onClose={() => setShowImpersonate(false)}
        />
      )}
    </div>
  )
}

type BadgeTone = 'green' | 'amber' | 'red' | 'blue' | 'slate'
function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const cls: Record<BadgeTone, string> = {
    green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red:   'bg-red-50 text-red-700 border-red-200',
    blue:  'bg-blue-50 text-blue-700 border-blue-200',
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
  }
  return <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${cls[tone]}`}>{children}</span>
}

function ActionButton({
  onClick, disabled, busy, tone, children,
}: {
  onClick: () => void
  disabled: boolean
  busy?: boolean
  tone: 'slate' | 'amber' | 'red'
  children: React.ReactNode
}) {
  const cls = tone === 'red'   ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100'
            : tone === 'amber' ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`border rounded-full px-3.5 py-1.5 text-xs font-medium disabled:opacity-50 ${cls}`}
    >
      {busy ? '…' : children}
    </button>
  )
}

function ImpersonateModal({
  targetUserId,
  targetEmail,
  onClose,
}: {
  targetUserId: string
  targetEmail: string
  onClose: () => void
}) {
  const [confirmEmail, setConfirmEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = confirmEmail.trim().toLowerCase() === targetEmail.toLowerCase() && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/actions/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId, confirmEmail: confirmEmail.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      // Hard reload to /dashboard so the new session cookie is read by all
      // server components.
      window.location.href = json.redirect ?? '/dashboard'
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold text-slate-900 mb-1">
          Impersonate {targetEmail}?
        </div>
        <p className="text-sm text-slate-600 mb-4">
          You&apos;ll see the app exactly as this merchant does, with all the same actions
          available. A red banner stays on top of every page while active. Click
          &quot;Stop impersonating&quot; in the banner to return.
        </p>
        <p className="text-xs text-slate-500 mb-4">
          Session auto-expires in 30 minutes. Start and stop are audit-logged.
        </p>

        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          Type the merchant email to confirm
        </label>
        <input
          value={confirmEmail}
          onChange={(e) => setConfirmEmail(e.target.value)}
          className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-red-500 mb-4"
          placeholder={targetEmail}
          autoFocus
          autoComplete="off"
        />

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm mb-4">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!ready}
            className={
              ready
                ? 'bg-red-600 text-white hover:bg-red-700 rounded-full px-5 py-2 text-sm font-medium'
                : 'bg-slate-200 text-slate-400 rounded-full px-5 py-2 text-sm font-medium cursor-not-allowed'
            }
          >
            {submitting ? 'Starting…' : 'Impersonate'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({
  label,
  rightSlot,
  children,
}: {
  label: string
  rightSlot?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          {label}
        </div>
        {rightSlot}
      </div>
      <div className="p-2">{children}</div>
    </section>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[180px_1fr] gap-2 px-3 py-1.5 text-sm">
      <div className="text-slate-500">{k}</div>
      <div className="text-slate-900 font-mono text-xs break-all">{v}</div>
    </div>
  )
}

function ErrorPanel({ error }: { error: string }) {
  return (
    <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
      <strong>Error.</strong> {error}
    </div>
  )
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/**
 * Custom pricing section (admin override of the tier ladder).
 *
 * Standard customers see "Standard (tiered: Starter/Growth/Scale/Enterprise)" +
 * an "Assign flat rate" button.
 * Flat-rate customers see "Custom flat rate — $X.XX/month" + a "Revert to
 * standard" button (which puts them back on the tier matching their MRR).
 *
 * Destructive actions (switch + revert) require typing the confirmation
 * string in an inline form — matches the existing admin pattern.
 */
function CustomPricingSection({
  customerId,
  currentCents,
  onChanged,
}: {
  customerId: string
  currentCents: number | null
  onChanged: () => Promise<void>
}) {
  const [mode, setMode]   = useState<'idle' | 'assigning' | 'reverting'>('idle')
  const [dollarStr, setDollarStr] = useState('299.00')
  const [confirmStr, setConfirmStr] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg]     = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isFlatRate = currentCents !== null
  const dollarsValid =
    /^\d+(\.\d{1,2})?$/.test(dollarStr) &&
    parseFloat(dollarStr) >= 1 &&
    parseFloat(dollarStr) <= 9999

  async function handleAssign() {
    if (!dollarsValid || confirmStr !== 'SWITCH') return
    setSubmitting(true)
    setError(null)
    setMsg(null)
    try {
      const cents = Math.round(parseFloat(dollarStr) * 100)
      const res = await fetch(`/api/admin/customers/${customerId}/custom-rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cents, confirm: 'SWITCH' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Assign failed')
      setMsg(json.priceUpdatedOnStripe ? `✓ Switched to $${dollarStr}/mo (Stripe subscription updated)` : `✓ Switched to $${dollarStr}/mo (no active Stripe sub to update)`)
      setMode('idle')
      setConfirmStr('')
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRevert() {
    if (confirmStr !== 'REVERT') return
    setSubmitting(true)
    setError(null)
    setMsg(null)
    try {
      const res = await fetch(`/api/admin/customers/${customerId}/custom-rate`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'REVERT' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Revert failed')
      setMsg(json.priceUpdatedOnStripe ? '✓ Reverted to standard tiered pricing (Stripe subscription updated to MRR-derived tier)' : '✓ Reverted to standard tiered pricing (no active Stripe sub to update)')
      setMode('idle')
      setConfirmStr('')
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">
        Custom pricing
      </div>

      {/* Current state line */}
      <p className="text-sm text-slate-700 mb-3">
        {isFlatRate ? (
          <>
            <strong>Custom flat rate — ${(currentCents! / 100).toFixed(2)} / month.</strong>{' '}
            <span className="text-slate-500">Tier ladder bypassed.</span>
          </>
        ) : (
          <>
            <strong>Standard.</strong>{' '}
            <span className="text-slate-500">Tiered: Starter $99 / Growth $299 / Scale $699 / Enterprise (sales). Tier auto-derived from MRR.</span>
          </>
        )}
      </p>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm mb-3">
          {error}
        </div>
      )}
      {msg && (
        <div className="bg-green-50 border border-green-200 text-green-800 rounded-xl p-3 text-sm mb-3">
          {msg}
        </div>
      )}

      {/* Assign mode */}
      {mode === 'assigning' && !isFlatRate && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
              Monthly amount (USD)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-slate-500 text-sm">$</span>
              <input
                type="text"
                inputMode="decimal"
                value={dollarStr}
                onChange={(e) => setDollarStr(e.target.value)}
                placeholder="299.00"
                className="border border-slate-200 rounded-full px-4 py-2 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="text-slate-500 text-sm">/ month</span>
            </div>
            {!dollarsValid && <p className="text-xs text-amber-700 mt-1">Enter between $1.00 and $9,999.00. For free comp, use the pilot mechanism instead.</p>}
          </div>
          <p className="text-xs text-slate-600">
            Saving will: set the customer&apos;s custom monthly rate, swap the Stripe subscription Price to a one-off custom Price at the new amount (no proration), and bypass the standard tier ladder for this customer. Future tier transitions are suppressed while the custom rate is active.
          </p>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
              Type <code className="bg-slate-100 px-1 rounded">SWITCH</code> to confirm
            </label>
            <input
              type="text"
              value={confirmStr}
              onChange={(e) => setConfirmStr(e.target.value)}
              placeholder="SWITCH"
              autoComplete="off"
              className="border border-slate-200 rounded-full px-4 py-2 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleAssign}
              disabled={submitting || !dollarsValid || confirmStr !== 'SWITCH'}
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-200 disabled:text-slate-400"
            >
              {submitting ? 'Saving…' : `Save & switch to $${dollarStr}/mo`}
            </button>
            <button
              type="button"
              onClick={() => { setMode('idle'); setConfirmStr(''); setError(null) }}
              disabled={submitting}
              className="text-slate-500 text-sm px-3 py-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Revert mode */}
      {mode === 'reverting' && isFlatRate && (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <p className="text-xs text-slate-600">
            Reverting will: clear the custom rate, swap the Stripe subscription back to the standard tier Price matching the customer&apos;s current recommended tier (no proration), and re-enable the standard tier-transition recommender for this customer.
          </p>
          <div>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
              Type <code className="bg-slate-100 px-1 rounded">REVERT</code> to confirm
            </label>
            <input
              type="text"
              value={confirmStr}
              onChange={(e) => setConfirmStr(e.target.value)}
              placeholder="REVERT"
              autoComplete="off"
              className="border border-slate-200 rounded-full px-4 py-2 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-red-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRevert}
              disabled={submitting || confirmStr !== 'REVERT'}
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:bg-slate-200 disabled:text-slate-400"
            >
              {submitting ? 'Saving…' : 'Revert to standard'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('idle'); setConfirmStr(''); setError(null) }}
              disabled={submitting}
              className="text-slate-500 text-sm px-3 py-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Idle: just show the trigger button */}
      {mode === 'idle' && !isFlatRate && (
        <button
          type="button"
          onClick={() => setMode('assigning')}
          className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-2 text-sm font-medium hover:bg-slate-50"
        >
          Assign flat rate
        </button>
      )}
      {mode === 'idle' && isFlatRate && (
        <button
          type="button"
          onClick={() => setMode('reverting')}
          className="border border-amber-200 bg-amber-50 text-amber-800 rounded-full px-4 py-2 text-sm font-medium hover:bg-amber-100"
        >
          Revert to standard
        </button>
      )}
    </section>
  )
}
