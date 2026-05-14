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

interface CronDecision {
  id: string
  name: string  // 'reengagement_skipped' | 'reengagement_email_sent' | 'email_sanity_check_failed'
  createdAt: string
  properties: Record<string, unknown>
}

interface Reply {
  id: string
  body: string
  fromEmail: string | null
  receivedAt: string
  inReplyToEmailId: string | null
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
  tier: number | null
  confidence: string | null
  cancellationReason: string | null
  cancellationCategory: string | null
  triggerNeed: string | null
  handoffReasoning: string | null
  // Spec 72 — classifier state
  classifiedAt: string | null
  classifyAttempts: number
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
}

interface Payload {
  subscriber: Subscriber | null
  emails: Email[]
  outcomeEvents: OutcomeEvent[]
  cronDecisions: CronDecision[]
  replies: Reply[]
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
  // Spec 70 #4 — "Send re-engagement now"
  const [sendNowOpen, setSendNowOpen] = useState(false)
  // Spec 70 #3 — force-status editing
  const [statusEditing, setStatusEditing] = useState(false)

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

  // Spec 72 — dead-letter banner. Shown when classify_attempts >= 3
  // AND the row still hasn't been classified successfully.
  const isDeadLettered = s.classifyAttempts >= 3 && !s.classifiedAt
  const isPendingClassify = !s.classifiedAt && s.classifyAttempts < 3

  return (
    <div className="space-y-6 max-w-4xl">
      <Link
        href="/admin/subscribers"
        className="text-xs text-slate-500 hover:underline"
      >
        ← Back to cross-customer search
      </Link>

      {isDeadLettered && (
        <DeadLetterBanner
          subscriberId={subscriberId}
          attempts={s.classifyAttempts}
          onReset={load}
        />
      )}
      {isPendingClassify && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-sm text-amber-900">
          ⏳ <strong>Pending classification.</strong> This subscriber was ingested but the
          classifier cron hasn&apos;t processed them yet (attempt {s.classifyAttempts} of 3).
          Re-classification typically runs within 2 minutes.
        </div>
      )}

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
            <p className="text-xs text-slate-400 italic md:col-span-2 mt-1">
              Full conversation history (replies + bodies) is in the timeline below.
            </p>
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

      {/* CRON DECISIONS — Spec 70 #1 */}
      <Section title="Cron decisions">
        <CronDecisionsList decisions={data.cronDecisions} />
      </Section>

      {/* TIMELINE */}
      <Section title="Conversation timeline">
        {data.emails.length === 0 && data.replies.length === 0 ? (
          <div className="text-sm text-slate-400 italic">No emails sent yet.</div>
        ) : (
          <Timeline
            subscriberId={subscriberId}
            emails={data.emails}
            replies={data.replies}
            outcomeEvents={data.outcomeEvents}
            cancelledAt={s.cancelledAt}
            expanded={expandedEmails}
            onToggle={toggleEmail}
          />
        )}
      </Section>

      {/* OUTCOME */}
      <Section title="Final outcome">
        <FinalOutcome
          subscriber={s}
          outcomeEvents={data.outcomeEvents}
          aiState={aiState}
          onEditStatus={() => setStatusEditing(true)}
        />
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
          <button
            onClick={() => setSendNowOpen(true)}
            className="border border-red-200 bg-red-50 text-red-800 rounded-full px-4 py-2 text-sm font-medium hover:bg-red-100"
          >
            Send re-engagement now (~$0.006)
          </button>
          <span className="text-xs text-slate-400">
            Live API calls. Re-classify is read-only. Send-now bypasses cooldown and may send a real email.
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

      {sendNowOpen && (
        <SendNowModal
          subscriberId={subscriberId}
          subscriberEmail={s.email}
          onClose={() => setSendNowOpen(false)}
          onDone={() => { setSendNowOpen(false); load() }}
        />
      )}

      {statusEditing && (
        <ForceStatusModal
          subscriberId={subscriberId}
          currentStatus={s.status ?? 'pending'}
          onClose={() => setStatusEditing(false)}
          onDone={() => { setStatusEditing(false); load() }}
        />
      )}
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
  subscriberId,
  emails,
  replies,
  outcomeEvents,
  cancelledAt,
  expanded,
  onToggle,
}: {
  subscriberId: string
  emails: Email[]
  replies: Reply[]
  outcomeEvents: OutcomeEvent[]
  cancelledAt: string | null
  expanded: Set<string>
  onToggle: (id: string) => void
}) {
  const [flaggedEmailIds, setFlaggedEmailIds] = useState<Set<string>>(new Set())
  const [flagging, setFlagging] = useState<string | null>(null)

  async function flagEmail(emailId: string) {
    const note = window.prompt('Flag this email for prompt-tuning review. Add a note (optional):') ?? ''
    if (note === null) return  // user hit Cancel — but prompt returns '' not null on empty
    setFlagging(emailId)
    try {
      const res = await fetch(`/api/admin/subscribers/${subscriberId}/flag-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId, note: note.trim() || undefined }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setFlaggedEmailIds((prev) => new Set(prev).add(emailId))
    } catch (e) {
      alert(`Flag failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setFlagging(null)
    }
  }

  // Build merged + chronological event list: outgoing emails + inbound replies
  // (Spec 71 — full bodies from wb_subscriber_replies) + outcome events.
  type Item =
    | { kind: 'email';   at: string; email: Email }
    | { kind: 'reply';   at: string; reply: Reply }
    | { kind: 'outcome'; at: string; event: OutcomeEvent }
  const items: Item[] = []
  for (const e of emails) {
    if (e.sentAt) items.push({ kind: 'email', at: e.sentAt, email: e })
  }
  for (const r of replies) {
    items.push({ kind: 'reply', at: r.receivedAt, reply: r })
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
          const isFlagged = flaggedEmailIds.has(it.email.id)
          const isFlagging = flagging === it.email.id
          return (
            <div key={`${idx}-email-${it.email.id}`} className="border-l-2 border-blue-300 pl-4">
              <div className="text-xs text-slate-400">{dayLabel} → outgoing ({it.email.type})</div>
              <div className="flex items-baseline gap-2">
                <button
                  onClick={() => onToggle(it.email.id)}
                  className="text-sm font-medium text-slate-900 hover:underline text-left"
                >
                  {it.email.subject ?? '(no subject)'} {isOpen ? '▾' : '▸'}
                </button>
                {isFlagged ? (
                  <span className="text-xs text-red-600">🚩 flagged</span>
                ) : (
                  <button
                    onClick={() => flagEmail(it.email.id)}
                    disabled={isFlagging}
                    className="text-xs text-slate-400 hover:text-red-600 disabled:opacity-50"
                  >
                    {isFlagging ? '…' : '🚩 flag'}
                  </button>
                )}
              </div>
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
          const isOpen = expanded.has(`reply-${it.reply.id}`)
          const threaded = !!it.reply.inReplyToEmailId
          return (
            <div key={`${idx}-reply-${it.reply.id}`} className="border-l-2 border-amber-300 pl-4">
              <div className="text-xs text-slate-400">
                {dayLabel} ← subscriber replied
                {!threaded && (
                  <span className="ml-2 text-amber-700" title="In-Reply-To header missing or didn't match a known outbound">
                    ⚠ thread unknown
                  </span>
                )}
              </div>
              <button
                onClick={() => onToggle(`reply-${it.reply.id}`)}
                className="text-sm font-medium text-slate-900 hover:underline text-left"
              >
                {it.reply.body.length > 80
                  ? `${it.reply.body.slice(0, 80).replace(/\s+/g, ' ').trim()}…`
                  : it.reply.body.replace(/\s+/g, ' ').trim()
                } {isOpen ? '▾' : '▸'}
              </button>
              {isOpen && (
                <div className="mt-2 bg-amber-50 border border-amber-100 rounded-lg p-3 text-xs whitespace-pre-wrap font-mono text-slate-700 max-h-96 overflow-y-auto">
                  {it.reply.body}
                </div>
              )}
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
  onEditStatus,
}: {
  subscriber: Subscriber
  outcomeEvents: OutcomeEvent[]
  aiState: string
  onEditStatus: () => void
}) {
  const handoffEvent = outcomeEvents.find((e) => e.name === 'founder_handoff_triggered')
  const recoveredEvent = outcomeEvents.find((e) => e.name === 'subscriber_recovered')
  const lostEvent = outcomeEvents.find((e) => e.name === 'subscriber_auto_lost')

  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <KV k="Status" v={subscriber.status ?? 'pending'} />
        <button
          onClick={onEditStatus}
          className="text-xs text-blue-600 hover:underline"
        >
          override →
        </button>
      </div>
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

/**
 * Spec 70 #4 — admin "Send re-engagement now" modal. Three LLM calls,
 * bypasses cooldown, may send a real email if the matcher fires.
 */
function SendNowModal({
  subscriberId,
  subscriberEmail,
  onClose,
  onDone,
}: {
  subscriberId: string
  subscriberEmail: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [confirmText, setConfirmText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ kind: string; reason?: string; improvementId?: string } | null>(null)
  const ready = confirmText === 'SEND' && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/subscribers/${subscriberId}/send-reengagement-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'SEND' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setOutcome(json.outcome)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
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
          Send re-engagement now?
        </div>
        <p className="text-sm text-slate-600 mb-4">
          Runs the full match-and-send pipeline for this subscriber, bypassing the 60-day cooldown.
          Three LLM calls (~$0.006). If an improvement matches and passes the sanity check, a real
          email goes to <strong>{subscriberEmail ?? '(no email)'}</strong>.
        </p>
        <p className="text-xs text-slate-500 mb-4">
          Customer pause and 9-month expiry gates still apply. Per-improvement-once stays — if the
          only matchable improvement was already sent, this will skip with no_match / no_improvements.
        </p>

        {outcome ? (
          <div className={`text-sm rounded-lg p-3 mb-4 ${
            outcome.kind === 'emailed'
              ? 'bg-green-50 border border-green-200 text-green-800'
              : outcome.kind === 'skipped'
              ? 'bg-amber-50 border border-amber-200 text-amber-800'
              : 'bg-red-50 border border-red-200 text-red-800'
          }`}>
            <div className="font-medium">Result: {outcome.kind}</div>
            {outcome.reason && <div>Reason: <code>{outcome.reason}</code></div>}
            {outcome.improvementId && <div>Improvement: <code>{outcome.improvementId.slice(0, 8)}</code></div>}
          </div>
        ) : (
          <>
            <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
              Type SEND to confirm
            </label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-red-500 mb-4"
              placeholder="SEND"
              autoFocus
              autoComplete="off"
            />
          </>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm mb-4">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={outcome ? onDone : onClose}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
          >
            {outcome ? 'Close' : 'Cancel'}
          </button>
          {!outcome && (
            <button
              onClick={submit}
              disabled={!ready}
              className={
                ready
                  ? 'bg-red-600 text-white hover:bg-red-700 rounded-full px-5 py-2 text-sm font-medium'
                  : 'bg-slate-200 text-slate-400 rounded-full px-5 py-2 text-sm font-medium cursor-not-allowed'
              }
            >
              {submitting ? 'Sending…' : 'Send now'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Spec 70 #3 — force-status dropdown modal. Override the auto-attributed
 * status with a mandatory note. Doesn't touch billing.
 */
function ForceStatusModal({
  subscriberId,
  currentStatus,
  onClose,
  onDone,
}: {
  subscriberId: string
  currentStatus: string
  onClose: () => void
  onDone: () => void
}) {
  const [newStatus, setNewStatus] = useState(currentStatus)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = newStatus !== currentStatus
  const ready = changed && note.trim().length >= 5 && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/subscribers/${subscriberId}/force-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, note: note.trim() }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      onDone()
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
          Override subscriber status
        </div>
        <p className="text-sm text-slate-600 mb-4">
          Current status: <code>{currentStatus}</code>. Changing this updates the row immediately
          and audit-logs the override. <strong>Doesn&apos;t touch billing</strong> — refunds and
          perf-fee charges flow through their own paths.
        </p>

        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          New status
        </label>
        <select
          value={newStatus}
          onChange={(e) => setNewStatus(e.target.value)}
          className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full mb-4 bg-white"
        >
          <option value="pending">pending</option>
          <option value="contacted">contacted</option>
          <option value="recovered">recovered</option>
          <option value="lost">lost</option>
        </select>

        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          Why? (audit-logged, required, min 5 chars)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="border border-slate-200 rounded-xl px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4 min-h-[5rem]"
          placeholder="e.g. Merchant confirmed via email — subscriber reactivated yesterday on their own"
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
                ? 'bg-[#0f172a] text-white hover:bg-[#1e293b] rounded-full px-5 py-2 text-sm font-medium'
                : 'bg-slate-200 text-slate-400 rounded-full px-5 py-2 text-sm font-medium cursor-not-allowed'
            }
          >
            {submitting ? 'Saving…' : 'Save override'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Spec 70 #1 — surface the V2 cron's per-subscriber decisions so support
 * can answer "why didn't subscriber X get an email?" without leaving the
 * inspector. Newest first; expandable for raw properties.
 */
function CronDecisionsList({ decisions }: { decisions: CronDecision[] }) {
  if (decisions.length === 0) {
    return (
      <div className="text-sm text-slate-400 italic">
        The re-engagement cron hasn&apos;t considered this subscriber yet
        (or these records pre-date Spec 70 instrumentation).
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {decisions.map((d) => {
        const ts = new Date(d.createdAt).toLocaleString()
        const { headline, tone } = describeCronDecision(d)
        return (
          <details key={d.id} className="border border-slate-100 rounded-lg group">
            <summary className="cursor-pointer list-none px-3 py-2 flex items-center gap-3 hover:bg-slate-50 rounded-lg">
              <span className="text-slate-400 text-xs group-open:rotate-90 transition-transform inline-block w-3">▸</span>
              <span className="text-xs text-slate-500 min-w-[10rem]">{ts}</span>
              <span className={`text-sm ${tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-700'}`}>
                {headline}
              </span>
            </summary>
            <pre className="px-3 pb-2 text-[11px] text-slate-500 whitespace-pre-wrap font-mono">
              {JSON.stringify(d.properties, null, 2)}
            </pre>
          </details>
        )
      })}
    </div>
  )
}

function describeCronDecision(d: CronDecision): { headline: string; tone: 'good' | 'bad' | 'neutral' } {
  const props = d.properties as Record<string, unknown>
  if (d.name === 'reengagement_email_sent') {
    const subject = typeof props.subject === 'string' ? props.subject : '(no subject)'
    return { headline: `Emailed → "${subject}"`, tone: 'good' }
  }
  if (d.name === 'email_sanity_check_failed') {
    const reason = typeof props.sanityReason === 'string' ? props.sanityReason : 'sanity check vetoed'
    return { headline: `Sanity-check failed — ${reason}`, tone: 'bad' }
  }
  // reengagement_skipped
  const reason = typeof props.reason === 'string' ? props.reason : 'unknown'
  const map: Record<string, string> = {
    customer_paused:  'Skipped — customer is paused for win-back/billing',
    low_confidence:   'Skipped — classifier confidence too low to match',
    no_match:         'Skipped — no active improvement matched the trigger need',
    no_improvements:  'Skipped — no eligible improvements for this subscriber',
    sanity_failed:    'Skipped — sanity check vetoed the drafted email',
    cooldown:         'Skipped — within the 60-day cooldown',
    expired:          'Skipped — past the 9-month wall',
  }
  return { headline: map[reason] ?? `Skipped — ${reason}`, tone: 'neutral' }
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

/**
 * Spec 72 — banner for dead-lettered rows. classify_attempts >= 3 means
 * the cron has tried 3 times and given up. Admin clicks Reset to zero
 * out the counter and let the cron retry once on the next tick.
 */
function DeadLetterBanner({
  subscriberId,
  attempts,
  onReset,
}: {
  subscriberId: string
  attempts: number
  onReset: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function reset() {
    if (!confirm(`Reset classify_attempts for this subscriber? The cron will retry once on the next tick (typically within 2 minutes).`)) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/subscribers/${subscriberId}/reset-classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      onReset()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <p className="font-semibold text-red-900">
            ⚠ Classification failed {attempts} times — dead-lettered
          </p>
          <p className="text-red-800 mt-1">
            The classifier cron has stopped retrying this row. Check{' '}
            <Link href="/admin/events?name=classify_failed" className="underline">
              recent classify_failed events
            </Link>{' '}
            for the last error. After fixing the underlying cause, reset
            to let the cron try once on the next tick.
          </p>
          {error && (
            <div className="mt-2 text-red-700 text-xs">{error}</div>
          )}
        </div>
        <button
          onClick={reset}
          disabled={submitting}
          className="flex-shrink-0 bg-red-600 text-white hover:bg-red-700 rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? 'Resetting…' : 'Reset & retry'}
        </button>
      </div>
    </div>
  )
}
