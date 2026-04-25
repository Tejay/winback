'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

interface Detail {
  identity: {
    id: string
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
    lastRun: { periodYyyymm: string; status: string; amountCents: number; createdAt: string } | null
    outstandingObligations: number
  }
  openHandoffs: number
}

export function CustomerDetailClient({ customerId }: { customerId: string }) {
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

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

  return (
    <div className="space-y-6">
      <Link href="/admin/customers" className="text-xs text-slate-500 hover:underline">
        ← Back to customers
      </Link>

      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Customer
        </div>
        <h1 className="text-3xl font-bold text-slate-900">
          {id.founderName ?? id.email}
          {id.productName && (
            <span className="ml-2 text-base font-normal text-slate-500">({id.productName})</span>
          )}
        </h1>
        <p className="text-sm text-slate-500">{id.email}</p>
      </header>

      {actionMsg && (
        <div className={`text-sm rounded-xl px-3 py-2 ${
          actionMsg.startsWith('✓')
            ? 'bg-green-50 text-green-800 border border-green-200'
            : 'bg-red-50 text-red-800 border border-red-200'
        }`}>{actionMsg}</div>
      )}

      <Section label="Identity">
        <KV k="Email" v={id.email} />
        <KV k="Notification email" v={id.notificationEmail ?? '(uses signin email)'} />
        <KV k="Plan" v={id.plan ?? 'trial'} />
        <KV k="Paused" v={id.pausedAt ? `since ${new Date(id.pausedAt).toLocaleString()}` : 'no'} />
        <KV k="Created" v={new Date(id.createdAt).toLocaleString()} />
      </Section>

      <Section label="Stripe health">
        <KV k="Account" v={id.stripeAccountId ?? '(not connected)'} />
        <KV k="Token" v={id.stripeConnected ? '✓ present' : '✗ missing/expired'} />
        <KV k="Last activity" v={data.stripeHealth.lastActivityAt
          ? new Date(data.stripeHealth.lastActivityAt).toLocaleString()
          : 'no events on record'} />
        <KV k="OAuth errors (7d)" v={String(data.stripeHealth.recentOauthErrors)} />
      </Section>

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

      <Section label="Recent events (last 50)" rightSlot={
        <Link href={`/admin/events?customerId=${id.id}`} className="text-xs text-blue-600 hover:underline">
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

      <Section label="Billing snapshot">
        <KV k="Last run" v={data.billing.lastRun
          ? `${data.billing.lastRun.periodYyyymm} · ${data.billing.lastRun.status} · $${(data.billing.lastRun.amountCents / 100).toFixed(2)}`
          : 'no runs yet'} />
        <KV k="Outstanding strong recoveries" v={String(data.billing.outstandingObligations)} />
        <KV k="Platform Stripe customer" v={id.stripePlatformCustomerId ?? '(no platform card on file)'} />
      </Section>

      <section className="bg-white rounded-2xl border border-amber-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-amber-700 mb-2">
          Emergency actions ⚠
        </div>
        <p className="text-sm text-slate-600 mb-3">
          All actions are audit-logged to <code>wb_events</code>.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => action('pause-customer', { paused: !id.pausedAt }, id.pausedAt ? 'Resumed sending' : 'Paused all sending')}
            disabled={busy !== null}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === 'pause-customer' ? '…' : id.pausedAt ? 'Resume sending' : 'Pause all sending'}
          </button>
          <button
            onClick={() => {
              if (!confirm('Force OAuth reset will clear the customer\'s Stripe access token. They will need to reconnect on next login. Continue?')) return
              action('force-oauth-reset', {}, 'OAuth reset')
            }}
            disabled={busy !== null}
            className="border border-amber-200 bg-amber-50 text-amber-800 rounded-full px-4 py-2 text-sm font-medium hover:bg-amber-100 disabled:opacity-50"
          >
            {busy === 'force-oauth-reset' ? '…' : 'Force OAuth reset'}
          </button>
          <button
            onClick={() => {
              if (data.openHandoffs === 0) return
              if (!confirm(`Resolve ${data.openHandoffs} open handoff(s) for this customer?`)) return
              action('resolve-handoff', {}, 'Handoffs resolved')
            }}
            disabled={busy !== null || data.openHandoffs === 0}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            Resolve {data.openHandoffs} open handoff{data.openHandoffs === 1 ? '' : 's'}
          </button>
        </div>
      </section>
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
