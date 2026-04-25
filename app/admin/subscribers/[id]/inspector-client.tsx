'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

interface Email {
  id: string
  type: string
  subject: string | null
  bodyText: string | null
  sentAt: string | null
  repliedAt: string | null
}

interface OutcomeEvent {
  id: string
  name: string
  createdAt: string
  properties: Record<string, unknown>
}

interface Subscriber {
  id: string
  customerId: string
  customerEmail: string | null
  customerProductName: string | null
  customerFounderName: string | null
  name: string | null
  email: string | null
  planName: string | null
  mrrCents: number
  status: string | null
  cancelledAt: string | null
  doNotContact: boolean | null
  founderHandoffAt: string | null
  founderHandoffResolvedAt: string | null
  aiPausedUntil: string | null
  aiPausedReason: string | null
  stripeEnum: string | null
  stripeComment: string | null
  tenureDays: number | null
  everUpgraded: boolean | null
  nearRenewal: boolean | null
  paymentFailures: number | null
  previousSubs: number | null
  billingPortalClickedAt: string | null
  replyText: string | null
  tier: number | null
  confidence: string | null
  cancellationReason: string | null
  cancellationCategory: string | null
  triggerNeed: string | null
  handoffReasoning: string | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
}

interface Payload {
  subscriber: Subscriber | null
  emails: Email[]
  outcomeEvents: OutcomeEvent[]
}

interface ReclassifyDiff {
  ok: boolean
  stored: {
    tier: number | null
    confidence: number | null
    cancellationReason: string | null
    cancellationCategory: string | null
    triggerNeed: string | null
    handoffReasoning: string | null
    recoveryLikelihood: string | null
  }
  fresh: {
    tier: number
    confidence: number
    cancellationReason: string
    cancellationCategory: string
    triggerNeed: string | null
    handoffReasoning: string
    recoveryLikelihood: string
    handoff: boolean
    tierReason: string
    firstMessage: { subject: string; body: string } | null
  }
}

const COST_CONFIRMATION = 'I understand this costs ~$0.003'

export function InspectorClient({ subscriberId }: { subscriberId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedEmails, setExpandedEmails] = useState<Set<string>>(new Set())
  const [signalsOpen, setSignalsOpen] = useState(false)
  const [reclassify, setReclassify] = useState<ReclassifyDiff | null>(null)
  const [reclassifyBusy, setReclassifyBusy] = useState(false)
  const [reclassifyMsg, setReclassifyMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/subscribers/${subscriberId}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [subscriberId])

  useEffect(() => { load() }, [load])

  function toggleEmail(id: string) {
    setExpandedEmails((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function runReclassify() {
    if (!confirm(`Run live classifier? Costs ~$0.003 in Anthropic API fees.\n\nThis will not modify any data — just shows what the AI would say today.`)) return
    setReclassifyBusy(true)
    setReclassifyMsg(null)
    try {
      const res = await fetch(`/api/admin/subscribers/${subscriberId}/re-classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmCost: COST_CONFIRMATION }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Re-classify failed')
      setReclassify(json)
      setReclassifyMsg('✓ Live re-run complete (no DB write)')
    } catch (e) {
      setReclassifyMsg(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setReclassifyBusy(false)
    }
  }

  if (loading && !data) return <p className="text-sm text-slate-500">Loading…</p>
  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
        <strong>Error.</strong> {error}
      </div>
    )
  }
  if (!data?.subscriber) return null

  const s = data.subscriber
  const handedOff = !!s.founderHandoffAt && !s.founderHandoffResolvedAt
  const paused = !!s.aiPausedUntil && new Date(s.aiPausedUntil).getTime() > Date.now()
  const aiState = handedOff ? 'handoff'
    : paused ? 'paused'
    : (s.status === 'recovered' || s.status === 'lost') ? 'done'
    : 'active'

  return (
    <div className="space-y-6 max-w-4xl">
      <Link
        href="/admin/subscribers"
        className="text-xs text-slate-500 hover:underline"
      >
        ← Back to cross-customer search
      </Link>

      <header className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600">
          Subscriber inspector
        </div>
        <h1 className="text-3xl font-bold text-slate-900">
          {s.name ?? '(no name)'}
          <span className="text-slate-400 font-normal text-lg ml-2">· {s.email ?? '(no email)'}</span>
        </h1>
        <div className="text-sm text-slate-500">
          on{' '}
          <Link
            href={`/admin/customers/${s.customerId}`}
            className="text-blue-600 hover:underline"
          >
            {s.customerProductName ?? s.customerFounderName ?? s.customerEmail ?? s.customerId.slice(0, 8)}
          </Link>
          {' · '}
          {s.planName ?? '?'} · ${(s.mrrCents / 100).toFixed(2)}/mo
          {s.cancelledAt && <> · cancelled {new Date(s.cancelledAt).toLocaleDateString()}</>}
        </div>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Badge color={statusColor(s.status ?? 'pending')}>{s.status ?? 'pending'}</Badge>
          <Badge color={aiStateColor(aiState)}>AI: {aiState}</Badge>
          {s.doNotContact && <Badge color="red">DNC</Badge>}
          {s.recoveryLikelihood && (
            <Badge color={likelihoodColor(s.recoveryLikelihood)}>
              recovery: {s.recoveryLikelihood}
            </Badge>
          )}
        </div>
      </header>

      {/* SIGNALS AT CHURN */}
      <Section
        title="Signals at churn"
        toggle={() => setSignalsOpen((v) => !v)}
        open={signalsOpen}
      >
        {signalsOpen && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <KV k="stripe_enum"             v={s.stripeEnum ?? '—'} />
            <KV k="tenure_days"             v={String(s.tenureDays ?? 0)} />
            <KV k="ever_upgraded"           v={String(s.everUpgraded ?? false)} />
            <KV k="near_renewal"            v={String(s.nearRenewal ?? false)} />
            <KV k="payment_failures"        v={String(s.paymentFailures ?? 0)} />
            <KV k="previous_subs"           v={String(s.previousSubs ?? 0)} />
            <KV k="billing_portal_clicked"  v={s.billingPortalClickedAt ? 'yes' : 'no'} />
            <KV k="cancelled_at"            v={s.cancelledAt ? new Date(s.cancelledAt).toISOString() : '—'} />
            {s.stripeComment && (
              <div className="md:col-span-2">
                <div className="text-xs text-slate-500 mt-2 mb-1">stripe_comment</div>
                <div className="text-sm italic bg-slate-50 rounded-lg p-2 border border-slate-100">
                  &ldquo;{s.stripeComment}&rdquo;
                </div>
              </div>
            )}
            {s.replyText && (
              <div className="md:col-span-2">
                <div className="text-xs text-slate-500 mt-2 mb-1">latest reply (only most recent is preserved)</div>
                <div className="text-sm italic bg-slate-50 rounded-lg p-2 border border-slate-100">
                  &ldquo;{s.replyText}&rdquo;
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* LATEST CLASSIFICATION */}
      <Section title="Classification (latest)">
        <div className="flex flex-wrap gap-2 mb-2 text-sm">
          {s.tier !== null && <Badge color="blue">Tier {s.tier}</Badge>}
          {s.confidence && <Badge color="slate">conf {Number(s.confidence).toFixed(2)}</Badge>}
          {s.cancellationCategory && <Badge color="purple">{s.cancellationCategory}</Badge>}
          {s.recoveryLikelihood && (
            <Badge color={likelihoodColor(s.recoveryLikelihood)}>
              recovery: {s.recoveryLikelihood}
            </Badge>
          )}
        </div>
        {s.cancellationReason && (
          <KV k="Reason" v={s.cancellationReason} />
        )}
        {s.triggerNeed && (
          <KV k="Trigger need" v={s.triggerNeed} mono />
        )}
        {s.handoffReasoning && (
          <div className="mt-2 bg-slate-50 rounded-lg p-3 border border-slate-100">
            <div className="text-xs text-slate-500 mb-1">AI reasoning (latest verdict)</div>
            <div className="text-sm italic text-slate-700">&ldquo;{s.handoffReasoning}&rdquo;</div>
          </div>
        )}
        <p className="text-xs text-slate-400 italic mt-2">
          Only the most recent verdict is preserved on the row. Earlier-turn reasoning isn&apos;t recorded yet — see Phase 4.
        </p>
      </Section>

      {/* TIMELINE */}
      <Section title="Conversation timeline">
        {data.emails.length === 0 ? (
          <div className="text-sm text-slate-400 italic">No emails sent yet.</div>
        ) : (
          <Timeline
            emails={data.emails}
            outcomeEvents={data.outcomeEvents}
            cancelledAt={s.cancelledAt}
            expanded={expandedEmails}
            onToggle={toggleEmail}
          />
        )}
      </Section>

      {/* OUTCOME */}
      <Section title="Final outcome">
        <FinalOutcome subscriber={s} outcomeEvents={data.outcomeEvents} aiState={aiState} />
      </Section>

      {/* ACTIONS */}
      <Section title="Actions">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={runReclassify}
            disabled={reclassifyBusy}
            className="border border-amber-200 bg-amber-50 text-amber-800 rounded-full px-4 py-2 text-sm font-medium hover:bg-amber-100 disabled:opacity-50"
          >
            {reclassifyBusy ? '…' : 'Re-run classifier (~$0.003)'}
          </button>
          <span className="text-xs text-slate-400">
            Live API call. No DB write — just shows the diff.
          </span>
        </div>
        {reclassifyMsg && (
          <div
            className={`text-sm rounded-xl px-3 py-2 mt-3 ${
              reclassifyMsg.startsWith('✓')
                ? 'bg-green-50 text-green-800 border border-green-200'
                : 'bg-red-50 text-red-800 border border-red-200'
            }`}
          >
            {reclassifyMsg}
          </div>
        )}
        {reclassify && <ReclassifyDiffPanel diff={reclassify} />}
      </Section>
    </div>
  )
}

// ─── components ───

function Section({
  title,
  open,
  toggle,
  children,
}: {
  title: string
  open?: boolean
  toggle?: () => void
  children: React.ReactNode
}) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div
        className={`flex items-center justify-between mb-3 ${toggle ? 'cursor-pointer' : ''}`}
        onClick={toggle}
      >
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          {title}
        </div>
        {toggle && (
          <span className="text-xs text-slate-400">
            {open ? '▾ collapse' : '▸ expand'}
          </span>
        )}
      </div>
      {(toggle === undefined || open) && children}
    </section>
  )
}

function KV({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-2 py-1 text-sm">
      <div className="text-slate-500">{k}</div>
      <div className={mono ? 'font-mono text-xs text-slate-800 break-all' : 'text-slate-800 break-words'}>{v}</div>
    </div>
  )
}

function Timeline({
  emails,
  outcomeEvents,
  cancelledAt,
  expanded,
  onToggle,
}: {
  emails: Email[]
  outcomeEvents: OutcomeEvent[]
  cancelledAt: string | null
  expanded: Set<string>
  onToggle: (id: string) => void
}) {
  // Build merged + chronological event list: emails (out + reply marker) + outcome events.
  type Item =
    | { kind: 'email'; at: string; email: Email }
    | { kind: 'reply'; at: string; email: Email }
    | { kind: 'outcome'; at: string; event: OutcomeEvent }
  const items: Item[] = []
  for (const e of emails) {
    if (e.sentAt) items.push({ kind: 'email', at: e.sentAt, email: e })
    if (e.repliedAt) items.push({ kind: 'reply', at: e.repliedAt, email: e })
  }
  for (const ev of outcomeEvents) {
    items.push({ kind: 'outcome', at: ev.createdAt, event: ev })
  }
  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  return (
    <div className="space-y-3">
      {items.map((it, idx) => {
        const day = cancelledAt
          ? Math.max(0, Math.floor((new Date(it.at).getTime() - new Date(cancelledAt).getTime()) / (24 * 60 * 60 * 1000)))
          : null
        const dayLabel = day !== null ? `Day ${day}` : new Date(it.at).toLocaleDateString()

        if (it.kind === 'email') {
          const isOpen = expanded.has(it.email.id)
          return (
            <div key={`${idx}-email-${it.email.id}`} className="border-l-2 border-blue-300 pl-4">
              <div className="text-xs text-slate-400">{dayLabel} → outgoing ({it.email.type})</div>
              <button
                onClick={() => onToggle(it.email.id)}
                className="text-sm font-medium text-slate-900 hover:underline text-left"
              >
                {it.email.subject ?? '(no subject)'} {isOpen ? '▾' : '▸'}
              </button>
              {isOpen && (
                <div className="mt-2 bg-slate-50 border border-slate-100 rounded-lg p-3 text-xs whitespace-pre-wrap font-mono text-slate-700 max-h-96 overflow-y-auto">
                  {it.email.bodyText
                    ? it.email.bodyText
                    : <span className="italic text-slate-400">(body not preserved — sent before instrumentation)</span>}
                </div>
              )}
            </div>
          )
        }
        if (it.kind === 'reply') {
          return (
            <div key={`${idx}-reply-${it.email.id}`} className="border-l-2 border-amber-300 pl-4">
              <div className="text-xs text-slate-400">{dayLabel} ← subscriber replied</div>
              <div className="text-xs italic text-slate-600">(reply tracked on email row; latest reply text shown in Signals)</div>
            </div>
          )
        }
        // outcome
        return (
          <div key={`${idx}-outcome-${it.event.id}`} className="border-l-2 border-purple-300 pl-4">
            <div className="text-xs text-slate-400">{dayLabel} ◇ outcome</div>
            <div className="text-sm font-mono text-purple-700">{it.event.name}</div>
            <pre className="text-[11px] text-slate-500 whitespace-pre-wrap mt-1">{JSON.stringify(it.event.properties, null, 2)}</pre>
          </div>
        )
      })}
    </div>
  )
}

function FinalOutcome({
  subscriber,
  outcomeEvents,
  aiState,
}: {
  subscriber: Subscriber
  outcomeEvents: OutcomeEvent[]
  aiState: string
}) {
  const handoffEvent = outcomeEvents.find((e) => e.name === 'founder_handoff_triggered')
  const recoveredEvent = outcomeEvents.find((e) => e.name === 'subscriber_recovered')
  const lostEvent = outcomeEvents.find((e) => e.name === 'subscriber_auto_lost')

  return (
    <div className="space-y-2 text-sm">
      <KV k="Status" v={subscriber.status ?? 'pending'} />
      <KV k="AI state" v={aiState} />
      {handoffEvent && (
        <>
          <KV k="Handoff at" v={new Date(handoffEvent.createdAt).toLocaleString()} />
          {typeof handoffEvent.properties.recoveryLikelihood === 'string' && (
            <KV k="Handoff likelihood" v={handoffEvent.properties.recoveryLikelihood} />
          )}
        </>
      )}
      {recoveredEvent && (
        <>
          <KV k="Recovered at" v={new Date(recoveredEvent.createdAt).toLocaleString()} />
          {typeof recoveredEvent.properties.attributionType === 'string' && (
            <KV k="Attribution" v={recoveredEvent.properties.attributionType} />
          )}
        </>
      )}
      {lostEvent && (
        <>
          <KV k="Auto-lost at" v={new Date(lostEvent.createdAt).toLocaleString()} />
          {typeof lostEvent.properties.reason === 'string' && (
            <KV k="Reason" v={lostEvent.properties.reason} />
          )}
        </>
      )}
      {!handoffEvent && !recoveredEvent && !lostEvent && (
        <div className="text-sm text-slate-400 italic">Funnel still in flight (no terminal outcome event yet).</div>
      )}
    </div>
  )
}

function ReclassifyDiffPanel({ diff }: { diff: ReclassifyDiff }) {
  const rows: Array<{ label: string; stored: string | null; fresh: string }> = [
    { label: 'tier', stored: diff.stored.tier?.toString() ?? null, fresh: diff.fresh.tier.toString() },
    { label: 'confidence', stored: diff.stored.confidence?.toFixed(2) ?? null, fresh: diff.fresh.confidence.toFixed(2) },
    { label: 'category', stored: diff.stored.cancellationCategory, fresh: diff.fresh.cancellationCategory },
    { label: 'recovery_likelihood', stored: diff.stored.recoveryLikelihood, fresh: diff.fresh.recoveryLikelihood },
    { label: 'cancellation_reason', stored: diff.stored.cancellationReason, fresh: diff.fresh.cancellationReason },
    { label: 'trigger_need', stored: diff.stored.triggerNeed, fresh: diff.fresh.triggerNeed ?? '(null)' },
    { label: 'handoff_reasoning', stored: diff.stored.handoffReasoning, fresh: diff.fresh.handoffReasoning },
  ]
  return (
    <div className="mt-4 bg-amber-50 border border-amber-200 rounded-xl p-4">
      <div className="text-xs font-semibold uppercase tracking-widest text-amber-700 mb-3">
        Stored vs. Fresh (today&apos;s prompt)
      </div>
      <div className="space-y-2 text-xs">
        {rows.map((row) => {
          const same = (row.stored ?? '') === (row.fresh ?? '')
          return (
            <div key={row.label} className="grid grid-cols-[140px_1fr_1fr_30px] gap-2">
              <div className="font-mono text-slate-500">{row.label}</div>
              <div className="font-mono text-slate-700 truncate" title={row.stored ?? '(null)'}>
                {row.stored ?? <span className="italic text-slate-400">(null)</span>}
              </div>
              <div className="font-mono text-slate-700 truncate" title={row.fresh}>{row.fresh}</div>
              <div className={same ? 'text-slate-400' : 'text-amber-600 font-bold'}>{same ? '✓' : '⚠'}</div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 text-xs italic text-slate-500">
        No DB write performed — this is a sandbox call.
      </div>
    </div>
  )
}

// ─── badge helpers (lifted from subscribers-search-client) ───

type BadgeColor = 'green' | 'amber' | 'red' | 'blue' | 'slate' | 'purple'

function Badge({ color, children }: { color: BadgeColor; children: React.ReactNode }) {
  const colors: Record<BadgeColor, string> = {
    green:  'bg-green-50 text-green-700 border-green-200',
    amber:  'bg-amber-50 text-amber-700 border-amber-200',
    red:    'bg-red-50 text-red-700 border-red-200',
    blue:   'bg-blue-50 text-blue-700 border-blue-200',
    slate:  'bg-slate-100 text-slate-600 border-slate-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border ${colors[color]}`}>
      {children}
    </span>
  )
}

function statusColor(status: string): BadgeColor {
  return status === 'recovered' ? 'green'
    : status === 'contacted' ? 'blue'
    : status === 'lost' ? 'slate'
    : 'amber'
}
function aiStateColor(state: string): BadgeColor {
  return state === 'handoff' ? 'amber'
    : state === 'paused' ? 'slate'
    : state === 'done' ? 'slate'
    : 'blue'
}
function likelihoodColor(l: string): BadgeColor {
  return l === 'high' ? 'green' : l === 'medium' ? 'amber' : 'slate'
}
