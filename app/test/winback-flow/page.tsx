'use client'

import { useState, useEffect } from 'react'

/**
 * Dev-only winback flow control panel.
 * Lets you seed 4 churned subscribers, simulate replies, and post a changelog
 * to see the full pipeline (classify → exit email → reply → re-classify →
 * follow-up → match → win-back).
 *
 * No real emails are sent. All content is generated and displayed here.
 *
 * Restricted to tejaasvi@gmail.com via the API route.
 */

interface SeedResult {
  scenario: string
  subscriberId?: string
  stripeProvisioned?: boolean
  stripeCustomerId?: string
  stripeSubscriptionId?: string
  signals?: {
    email: string
    stripeEnum: string
    stripeComment: string
  }
  classification?: {
    tier: number
    tierReason: string
    cancellationReason: string
    cancellationCategory: string
    confidence: number
    suppress: boolean
    triggerKeyword: string | null
    triggerNeed: string | null
  }
  exitEmail?: { subject: string; body: string } | null
  error?: string
}

interface ReplyResult {
  reclassification?: {
    tier: number
    tierReason: string
    cancellationReason: string
    cancellationCategory: string
    confidence: number
    triggerKeyword: string | null
    triggerNeed: string | null
  }
  followUpEmail?: { subject: string; body: string } | null
  followUpSkipped?: boolean
  followUpSkipReason?: string | null
}

interface RecoveryResult {
  recoveryId: string
  attributionType: 'strong' | 'weak' | 'organic'
  planMrrCents: number
  billableForInvoice: boolean
}

interface ChangelogResult {
  candidatesCount: number
  matchedCount: number
  verdicts: Array<{
    subscriberId: string
    subscriberName: string | null
    need: string
    matched: boolean
  }>
  emails: Array<{
    subscriberId: string
    subscriberName: string | null
    need: string
    generated: { subject: string; body: string } | null
  }>
}

const DEFAULT_REPLIES: Record<string, string> = {
  'Alice — Price': "Yeah, $29 was steep. If you had a $9 plan with the basics I'd probably stick around.",
  'Bob — Feature': "Honestly the CSV export is the only thing I needed. Without it I can't share data with my accountant easily.",
  'Carol — Competitor': "Linear has been working well, no plans to switch back right now. Sorry!",
  'Dave — Quality': "It crashed every time I opened the dashboard on Safari. If you've fixed that I might give it another shot.",
}

const DEFAULT_CHANGELOG = `This week we shipped:

- Spreadsheet downloads (CSV format) for any data view
- A Starter plan at $9/mo for solo users
- Fixed the Safari dashboard rendering bug that was causing crashes
- Improved Slack integration with custom alert routing`

export default function WinbackFlowPage() {
  const [loading, setLoading] = useState<string | null>(null)
  const [seedResults, setSeedResults] = useState<SeedResult[]>([])
  const [stripeWarning, setStripeWarning] = useState<string | null>(null)
  const [replies, setReplies] = useState<Record<string, string>>({})
  const [replyResults, setReplyResults] = useState<Record<string, ReplyResult>>({})
  const [recoveryResults, setRecoveryResults] = useState<Record<string, RecoveryResult>>({})
  const [changelogText, setChangelogText] = useState(DEFAULT_CHANGELOG)
  const [changelogResult, setChangelogResult] = useState<ChangelogResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Initialize default replies once seed results come in
  useEffect(() => {
    const next: Record<string, string> = {}
    for (const r of seedResults) {
      if (r.subscriberId && !replies[r.subscriberId]) {
        next[r.subscriberId] = DEFAULT_REPLIES[r.scenario] ?? ''
      }
    }
    if (Object.keys(next).length > 0) {
      setReplies(prev => ({ ...prev, ...next }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedResults])

  async function call(action: string, extra: Record<string, unknown> = {}) {
    setError(null)
    setLoading(action)
    try {
      const res = await fetch('/api/test/winback-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Unknown error')
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setLoading(null)
    }
  }

  async function seed() {
    const data = await call('seed')
    if (data?.results) {
      setSeedResults(data.results)
      setStripeWarning(data.stripeWarning ?? null)
      setReplyResults({})
      setRecoveryResults({})
      setChangelogResult(null)
    }
  }

  async function reset() {
    await call('reset')
    setSeedResults([])
    setReplyResults({})
    setRecoveryResults({})
    setChangelogResult(null)
    setReplies({})
  }

  async function sendReply(subscriberId: string, scenarioLabel: string) {
    const replyText = replies[subscriberId]
    if (!replyText?.trim()) return
    const data = await call('reply', { subscriberId, replyText })
    if (data) {
      setReplyResults(prev => ({ ...prev, [subscriberId]: data }))
    }
  }

  async function simulateRecovery(subscriberId: string, attributionType: 'strong' | 'weak' | 'organic') {
    const data = await call('simulate-recovery', { subscriberId, attributionType })
    if (data) {
      setRecoveryResults(prev => ({ ...prev, [subscriberId]: data }))
    }
  }

  async function postChangelog() {
    const data = await call('changelog', { changelogText })
    if (data) setChangelogResult(data)
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600 mb-2">
            Dev Test Harness
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Winback Flow.</h1>
          <p className="text-sm text-slate-600 max-w-2xl">
            Seeds 4 simulated churned subscribers (Price, Feature, Competitor, Quality),
            runs them through the live classifier, lets you simulate replies for re-classification,
            and tests the new semantic changelog matcher + at-match-time win-back email generation.
            <strong> No real emails are sent</strong> — generated content is shown below for inspection.
          </p>
        </header>

        {error && (
          <div className="mb-6 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* STEP 1 — SEED */}
        <Section
          step={1}
          title="Seed 4 churned subscribers"
          subtitle="Each scenario triggers the classifier with different signals. Look at the resulting tier, triggerNeed, and exit email."
        >
          <div className="flex gap-2 mb-4">
            <Button onClick={seed} disabled={!!loading} loading={loading === 'seed'}>
              {seedResults.length > 0 ? 'Re-seed (clears existing)' : 'Seed 4 subscribers'}
            </Button>
            {seedResults.length > 0 && (
              <Button onClick={reset} variant="secondary" disabled={!!loading} loading={loading === 'reset'}>
                Delete all test subs
              </Button>
            )}
          </div>

          {stripeWarning && (
            <div className="mb-4 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
              <strong>Heads up:</strong> {stripeWarning}
            </div>
          )}

          {seedResults.length > 0 && seedResults.some(r => r.stripeProvisioned) && (
            <div className="mb-4 px-4 py-3 bg-green-50 border border-green-200 rounded-xl text-sm text-green-900">
              ✓ Real Stripe test customers + subscriptions created. The resubscribe link in each email will <strong>resume</strong> the subscription via the live reactivate flow → strong recovery.
            </div>
          )}

          {seedResults.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {seedResults.map((r) => (
                <SubscriberCard key={r.scenario} result={r} />
              ))}
            </div>
          )}
        </Section>

        {/* STEP 2 — REPLIES */}
        {seedResults.length > 0 && (
          <Section
            step={2}
            title="Simulate replies, re-classification & recovery"
            subtitle="Edit each reply, then send — the inbound flow re-classifies with the reply text as highest-signal input and shows the would-be follow-up. Or click Strong / Weak / Organic to simulate a recovery directly (useful for testing attribution + billing without going through Stripe Checkout)."
          >
            <div className="space-y-4">
              {seedResults
                .filter(r => r.subscriberId)
                .map((r) => (
                  <ReplyCard
                    key={r.subscriberId}
                    result={r}
                    replyText={replies[r.subscriberId!] ?? ''}
                    onReplyChange={(text) =>
                      setReplies(prev => ({ ...prev, [r.subscriberId!]: text }))
                    }
                    onSend={() => sendReply(r.subscriberId!, r.scenario)}
                    sending={loading === 'reply' || loading === 'simulate-recovery'}
                    replyResult={replyResults[r.subscriberId!]}
                    recoveryResult={recoveryResults[r.subscriberId!]}
                    onSimulateRecovery={(attributionType) =>
                      simulateRecovery(r.subscriberId!, attributionType)
                    }
                  />
                ))}
            </div>
          </Section>
        )}

        {/* STEP 3 — CHANGELOG */}
        {seedResults.length > 0 && (
          <Section
            step={3}
            title="Post a changelog (semantic match + at-match-time win-back generation)"
            subtitle="The matcher is given each subscriber's triggerNeed and the changelog. For each match, a fresh win-back email is generated referencing the actual changelog text."
          >
            <textarea
              value={changelogText}
              onChange={(e) => setChangelogText(e.target.value)}
              rows={8}
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm font-mono"
              placeholder="What did you ship this week?"
            />
            <div className="mt-3">
              <Button onClick={postChangelog} disabled={!!loading} loading={loading === 'changelog'}>
                Run matcher + generate emails
              </Button>
            </div>

            {changelogResult && <ChangelogResultBlock result={changelogResult} />}
          </Section>
        )}
      </div>
    </div>
  )
}

// ─── components ───

function Section({
  step,
  title,
  subtitle,
  children,
}: {
  step: number
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-8 bg-white rounded-2xl border border-slate-200 p-6">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-bold flex items-center justify-center flex-shrink-0">
          {step}
        </div>
        <div>
          <h2 className="text-lg font-bold text-slate-900">{title}</h2>
          <p className="text-sm text-slate-600 mt-1">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

function Button({
  children,
  onClick,
  disabled,
  loading,
  variant = 'primary',
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  variant?: 'primary' | 'secondary'
}) {
  const base = 'rounded-full px-5 py-2 text-sm font-medium transition-colors'
  const styles =
    variant === 'primary'
      ? 'bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed'
      : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50'
  return (
    <button onClick={onClick} disabled={disabled || loading} className={`${base} ${styles}`}>
      {loading ? '…' : children}
    </button>
  )
}

function SubscriberCard({ result }: { result: SeedResult }) {
  if (result.error) {
    return (
      <div className="border border-red-200 bg-red-50 rounded-xl p-4">
        <div className="font-semibold text-red-900">{result.scenario}</div>
        <div className="text-xs text-red-700 mt-1">Error: {result.error}</div>
      </div>
    )
  }
  const c = result.classification!
  return (
    <div className="border border-slate-200 rounded-xl p-4">
      <div className="flex items-start justify-between mb-2">
        <div className="font-semibold text-slate-900">{result.scenario}</div>
        {result.stripeProvisioned ? (
          <Badge color="green">Real Stripe sub</Badge>
        ) : (
          <Badge color="amber">Fake Stripe IDs</Badge>
        )}
      </div>

      {result.stripeCustomerId && (
        <Field label="Stripe customer" value={result.stripeCustomerId} mono small />
      )}

      <Field label="Stripe enum" value={result.signals!.stripeEnum} mono />
      <Field label="Stripe comment" value={`"${result.signals!.stripeComment}"`} />

      <Divider />

      <div className="flex flex-wrap gap-2 mb-3">
        <Badge color="blue">Tier {c.tier}</Badge>
        <Badge color="purple">{c.cancellationCategory}</Badge>
        <Badge color="slate">conf {c.confidence.toFixed(2)}</Badge>
        {c.suppress && <Badge color="red">SUPPRESS</Badge>}
      </div>

      <Field label="Cancellation reason" value={c.cancellationReason} />
      <Field label="Tier reason" value={c.tierReason} small />
      <Field label="triggerKeyword (legacy)" value={c.triggerKeyword ?? '(null)'} mono small />
      <Field label="triggerNeed (new)" value={c.triggerNeed ?? '(null)'} mono />

      {result.exitEmail ? (
        <>
          <Divider />
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
            Exit email (would be sent)
          </div>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs">
            <div className="font-semibold mb-2">Subject: {result.exitEmail.subject}</div>
            <div className="whitespace-pre-wrap text-slate-700">{result.exitEmail.body}</div>
          </div>
        </>
      ) : (
        <div className="mt-3 text-xs italic text-slate-500">No exit email (suppressed)</div>
      )}
    </div>
  )
}

function ReplyCard({
  result,
  replyText,
  onReplyChange,
  onSend,
  sending,
  replyResult,
  recoveryResult,
  onSimulateRecovery,
}: {
  result: SeedResult
  replyText: string
  onReplyChange: (text: string) => void
  onSend: () => void
  sending: boolean
  replyResult?: ReplyResult
  recoveryResult?: RecoveryResult
  onSimulateRecovery: (attributionType: 'strong' | 'weak' | 'organic') => void
}) {
  return (
    <div className="border border-slate-200 rounded-xl p-4">
      <div className="flex items-start justify-between mb-3 gap-2">
        <div className="font-semibold text-slate-900">{result.scenario}</div>
        {recoveryResult && (
          <Badge color={recoveryResult.attributionType === 'strong' ? 'green' : recoveryResult.attributionType === 'weak' ? 'amber' : 'slate'}>
            ✓ Recovered · {recoveryResult.attributionType}
          </Badge>
        )}
      </div>

      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
        Subscriber's reply
      </div>
      <textarea
        value={replyText}
        onChange={(e) => onReplyChange(e.target.value)}
        rows={2}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button onClick={onSend} disabled={sending || !replyText.trim() || !!recoveryResult}>
          Send reply → re-classify
        </Button>
        {!recoveryResult && (
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs text-slate-400 mr-1">Simulate recovery:</span>
            <button
              onClick={() => onSimulateRecovery('strong')}
              disabled={sending}
              className="border border-green-200 bg-green-50 text-green-700 rounded-full px-2.5 py-1 text-xs font-medium hover:bg-green-100 disabled:opacity-50"
              title="Billable — invoice cron will charge this"
            >
              Strong
            </button>
            <button
              onClick={() => onSimulateRecovery('weak')}
              disabled={sending}
              className="border border-amber-200 bg-amber-50 text-amber-700 rounded-full px-2.5 py-1 text-xs font-medium hover:bg-amber-100 disabled:opacity-50"
              title="Not billed but tracked"
            >
              Weak
            </button>
            <button
              onClick={() => onSimulateRecovery('organic')}
              disabled={sending}
              className="border border-slate-200 bg-slate-50 text-slate-600 rounded-full px-2.5 py-1 text-xs font-medium hover:bg-slate-100 disabled:opacity-50"
              title="Not billed, not credited"
            >
              Organic
            </button>
          </div>
        )}
      </div>

      {recoveryResult && (
        <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg text-xs">
          <div className="font-semibold text-green-900 mb-1">
            ✓ Synthetic recovery recorded
          </div>
          <div className="text-slate-700">
            Attribution: <strong>{recoveryResult.attributionType}</strong> ·
            Plan MRR: ${(recoveryResult.planMrrCents / 100).toFixed(2)}/mo
            {recoveryResult.billableForInvoice
              ? ' · ✓ Will be on next monthly invoice (15%)'
              : ' · Not billable'}
          </div>
        </div>
      )}

      {replyResult && (
        <>
          <Divider />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Re-classification
              </div>
              <div className="flex flex-wrap gap-2 mb-2">
                <Badge color="blue">Tier {replyResult.reclassification!.tier}</Badge>
                <Badge color="purple">{replyResult.reclassification!.cancellationCategory}</Badge>
                <Badge color="slate">conf {replyResult.reclassification!.confidence.toFixed(2)}</Badge>
              </div>
              <Field label="Reason" value={replyResult.reclassification!.cancellationReason} small />
              <Field label="Tier reason" value={replyResult.reclassification!.tierReason} small />
              <Field label="triggerNeed" value={replyResult.reclassification!.triggerNeed ?? '(null)'} mono small />
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                Follow-up email (would be sent)
              </div>
              {replyResult.followUpEmail ? (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs">
                  <div className="font-semibold mb-2">
                    Subject: {replyResult.followUpEmail.subject}
                  </div>
                  <div className="whitespace-pre-wrap text-slate-700">
                    {replyResult.followUpEmail.body}
                  </div>
                </div>
              ) : (
                <div className="text-xs italic text-slate-500">
                  Skipped: {replyResult.followUpSkipReason ?? 'no message'}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ChangelogResultBlock({ result }: { result: ChangelogResult }) {
  return (
    <div className="mt-6">
      <div className="flex gap-2 mb-4 text-sm">
        <Badge color="slate">{result.candidatesCount} candidates</Badge>
        <Badge color="green">{result.matchedCount} matched</Badge>
        <Badge color="amber">{result.candidatesCount - result.matchedCount} not matched</Badge>
      </div>

      <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
        LLM matcher verdicts
      </div>
      <div className="space-y-2 mb-6">
        {result.verdicts.map((v) => (
          <div
            key={v.subscriberId}
            className={`border rounded-lg p-3 text-sm ${
              v.matched
                ? 'border-green-200 bg-green-50'
                : 'border-slate-200 bg-slate-50'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold">{v.subscriberName}</span>
              {v.matched ? (
                <Badge color="green">✓ MATCH</Badge>
              ) : (
                <Badge color="slate">no match</Badge>
              )}
            </div>
            <div className="text-xs text-slate-600">
              <span className="font-mono">need:</span> "{v.need}"
            </div>
          </div>
        ))}
      </div>

      {result.emails.length > 0 && (
        <>
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
            Generated win-back emails (at match time, referencing actual changelog)
          </div>
          <div className="space-y-3">
            {result.emails.map((e) => (
              <div key={e.subscriberId} className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="text-xs text-slate-600 mb-2">
                  → <strong>{e.subscriberName}</strong>{' '}
                  <span className="font-mono">(need: "{e.need}")</span>
                </div>
                {e.generated ? (
                  <>
                    <div className="font-semibold text-sm mb-2">
                      Subject: {e.generated.subject}
                    </div>
                    <div className="text-sm whitespace-pre-wrap text-slate-800">
                      {e.generated.body}
                    </div>
                  </>
                ) : (
                  <div className="text-sm italic text-red-600">
                    Email generation failed (see server logs)
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  mono = false,
  small = false,
}: {
  label: string
  value: string
  mono?: boolean
  small?: boolean
}) {
  return (
    <div className={`mb-2 ${small ? 'text-xs' : 'text-sm'}`}>
      <span className="text-slate-500 font-medium">{label}: </span>
      <span className={mono ? 'font-mono text-slate-800' : 'text-slate-800'}>{value}</span>
    </div>
  )
}

function Divider() {
  return <div className="my-3 border-t border-slate-100" />
}

function Badge({
  children,
  color,
}: {
  children: React.ReactNode
  color: 'blue' | 'green' | 'amber' | 'red' | 'slate' | 'purple'
}) {
  const colors = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    slate: 'bg-slate-100 text-slate-700 border-slate-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
  }
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border ${colors[color]}`}
    >
      {children}
    </span>
  )
}
