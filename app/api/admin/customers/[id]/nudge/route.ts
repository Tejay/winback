import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { z } from 'zod'
import { and, desc, eq, gte } from 'drizzle-orm'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, wbEvents } from '@/lib/schema'
import { resolveFounderNotificationEmail } from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/customers/[id]/nudge  { stage }
 *
 * Admin-triggered outreach to a merchant who is stuck at a funnel stage
 * (from /admin/insights/funnel). Sends a short, honest stage-specific email,
 * logs a `funnel_nudge_sent` event, and is soft-guarded to once per 24h per
 * customer (read from that event — no schema column needed).
 *
 * NOTE: like the existing onboarding/billing nudges, this constructs Resend
 * directly and respects the merchant's billing-email opt-out. On a dev box
 * (NODE_ENV !== production, `live` sending mode) this sends a REAL email —
 * the parked dev-email allowlist would gate that.
 */

const STAGES = ['registeredNotViewed', 'viewedNotConnected', 'connectedNotActivated', 'activatedNotSubscribed'] as const
type Stage = (typeof STAGES)[number]

const bodySchema = z.object({ stage: z.enum(STAGES) })

const NUDGE_GUARD_MS = 24 * 60 * 60 * 1000
const FROM = 'Winback <noreply@winbackflow.co>'

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
}

function copyFor(stage: Stage, founderName: string | null, recoveredCents: number): { subject: string; text: string } {
  const hi = `Hi ${founderName?.split(' ')[0] ?? 'there'},`
  switch (stage) {
    case 'registeredNotViewed':
    case 'viewedNotConnected':
      return {
        subject: 'Finish setting up WinbackFlow (30 seconds)',
        text: `${hi}\n\nYou signed up for WinbackFlow but haven't connected Stripe yet. It takes about 30 seconds, and we start finding recoverable revenue the moment you do.\n\nConnect Stripe: ${appUrl()}/onboarding/stripe\n\n— The WinbackFlow team`,
      }
    case 'connectedNotActivated':
      return {
        subject: 'WinbackFlow is watching your Stripe',
        text: `${hi}\n\nYou're all set up — we're monitoring your Stripe for cancellations and failed payments. There's nothing to do right now; we'll email you the moment we recover someone.\n\nYour dashboard: ${appUrl()}/dashboard\n\n— The WinbackFlow team`,
      }
    case 'activatedNotSubscribed': {
      const amount = recoveredCents > 0 ? `$${Math.round(recoveredCents / 100).toLocaleString()} ` : ''
      return {
        subject: 'Keep your recoveries running',
        text: `${hi}\n\nWinbackFlow has already recovered ${amount}for you. Subscribe to keep recoveries running on every future cancellation and failed payment.\n\nSubscribe: ${appUrl()}/dashboard?subscribe=1\n\n— The WinbackFlow team`,
      }
    }
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { id: customerId } = await params

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid stage' }, { status: 400 })
  const { stage } = parsed.data

  const [customer] = await db
    .select({
      id: customers.id,
      founderName: customers.founderName,
      optedOutAt: customers.billingEmailsOptedOutAt,
      recoveredCents: customers.cumulativeRevenueSavedCents,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  if (customer.optedOutAt) return NextResponse.json({ ok: false, skipped: 'opted_out' })

  // Soft 24h re-send guard, read from the event log (no schema column).
  const [recent] = await db
    .select({ at: wbEvents.createdAt })
    .from(wbEvents)
    .where(and(
      eq(wbEvents.name, 'funnel_nudge_sent'),
      eq(wbEvents.customerId, customerId),
      gte(wbEvents.createdAt, new Date(Date.now() - NUDGE_GUARD_MS)),
    ))
    .orderBy(desc(wbEvents.createdAt))
    .limit(1)
  if (recent) return NextResponse.json({ ok: false, skipped: 'recently_nudged', lastSentAt: recent.at })

  const to = await resolveFounderNotificationEmail(customerId)
  if (!to) return NextResponse.json({ ok: false, skipped: 'no_email' })

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'RESEND_API_KEY not configured' }, { status: 503 })

  const { subject, text } = copyFor(stage, customer.founderName, Number(customer.recoveredCents ?? 0))
  try {
    const resend = new Resend(apiKey)
    await resend.emails.send({ from: FROM, to, subject, text })
  } catch (err) {
    console.error('[admin/nudge] send failed', customerId, err)
    return NextResponse.json({ error: 'Send failed' }, { status: 502 })
  }

  await logEvent({ name: 'funnel_nudge_sent', customerId, userId: auth.userId, properties: { stage, to } })
  return NextResponse.json({ ok: true })
}
