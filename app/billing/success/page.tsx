import { type ReactNode } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { getPlatformStripe } from '@/src/winback/lib/platform-stripe'
import { setDefaultPaymentMethod } from '@/src/winback/lib/platform-billing'
import { ensureActivation, type ActivationState } from '@/src/winback/lib/activation'
import { getPausedQueueCounts, type QueueCounts } from '@/src/winback/lib/pause-drain'

/**
 * Spec 52 — Subscribe success landing page.
 *
 * Stripe Checkout's success_url points here with the
 * {CHECKOUT_SESSION_ID} placeholder filled in. Before rendering, we
 * synchronously: retrieve the Checkout session, set the new card as
 * default PM, and call ensureActivation() to create the Stripe
 * Subscription. This is the primary trigger; the webhook handler
 * remains in place as a redundant second trigger for cases where the
 * redirect never completes.
 *
 * All side-effects are idempotent: ensureActivation reads DB/Stripe
 * state and returns 'active' (no-op) if the subscription already
 * exists. Safe to refresh or revisit.
 */
export default async function BillingSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const { session_id: sessionId } = await searchParams

  const [customer] = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
    })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  // Fallback state when we can't even map the user to a customer row.
  // Treated the same as a transient failure — direct them back to the
  // dashboard; the webhook will catch up if anything actually happened
  // on the Stripe side.
  if (!customer || !sessionId) {
    return <Shell tone="pending" />
  }

  let outcome: ActivationState | { state: 'error' } = { state: 'error' }

  try {
    const stripe = getPlatformStripe()
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent'],
    })

    // Defence in depth — verify the Checkout session was created for
    // *this* authenticated customer, not a leaked / brute-forced id.
    if (checkoutSession.metadata?.winback_customer_id !== customer.id) {
      console.warn(
        `[billing/success] session_id ${sessionId} metadata customer mismatch:`,
        `expected ${customer.id}, got ${checkoutSession.metadata?.winback_customer_id}`,
      )
      return <Shell tone="pending" />
    }

    // Pull the PM from the SetupIntent and promote it to default. This
    // is the same operation processPlatformCardCapture runs in the
    // webhook path; either path is safe to call first.
    const setupIntent = checkoutSession.setup_intent
    const paymentMethodId =
      typeof setupIntent === 'object' && setupIntent !== null
        ? typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : setupIntent.payment_method?.id ?? null
        : null

    if (paymentMethodId && customer.stripePlatformCustomerId) {
      await setDefaultPaymentMethod(customer.stripePlatformCustomerId, paymentMethodId)
    }

    outcome = await ensureActivation(customer.id)
  } catch (err) {
    console.error('[billing/success] sync activation failed:', err)
    outcome = { state: 'error' }
  }

  // Spec 54 — once activation has run (state=active), look up the paused-
  // window queue counts so we can surface "we're processing N events…".
  // Cron at /api/cron/drain-paused-queue does the actual processing; this
  // page is just informing the merchant. On error, omit the line.
  let queueCounts: QueueCounts | null = null
  if (outcome.state === 'active') {
    try {
      queueCounts = await getPausedQueueCounts(customer.id)
    } catch (err) {
      console.warn('[billing/success] queue counts lookup failed:', err)
    }
  }

  if (outcome.state === 'active') return <Shell tone="success" queueCounts={queueCounts} />
  if (outcome.state === 'pilot') return <Shell tone="pilot" />
  return <Shell tone="pending" />
}

type Tone = 'success' | 'pilot' | 'pending'

function Shell({ tone, queueCounts }: { tone: Tone; queueCounts?: QueueCounts | null }) {
  const { icon, title, body } = COPY[tone]
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="flex justify-center mt-12 mb-8">
        <Logo />
      </div>
      <div className="max-w-md mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
        <div className="flex justify-center mb-4">{icon}</div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">{title}</h1>
        <p className="text-sm text-slate-600 leading-relaxed mb-3">{body}</p>
        {queueCounts && queueCounts.total > 0 && (
          <p className="text-xs text-slate-500 leading-relaxed mb-6">
            {queueDrainCopy(queueCounts)}
          </p>
        )}
        {(!queueCounts || queueCounts.total === 0) && <div className="mb-6" />}
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] transition-colors"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}

// Spec 54 — drain queue copy. Examples:
//   "3 cancellations" / "1 failed payment + 2 replies" / "5 events"
// Style mirrors the spec 53 banner cohort breakdown.
function queueDrainCopy(c: QueueCounts): string {
  const parts: string[] = []
  if (c.cancellations > 0) parts.push(`${c.cancellations} ${c.cancellations === 1 ? 'cancellation' : 'cancellations'}`)
  if (c.paymentRecoveries > 0) parts.push(`${c.paymentRecoveries} failed ${c.paymentRecoveries === 1 ? 'payment' : 'payments'}`)
  if (c.replies > 0) parts.push(`${c.replies} ${c.replies === 1 ? 'reply' : 'replies'}`)
  const breakdown = parts.join(' + ')
  return `We're now processing ${c.total} ${c.total === 1 ? 'event' : 'events'} from your trial-paused window (${breakdown}). Most will land in your dashboard within a few minutes.`
}

const COPY: Record<Tone, { icon: ReactNode; title: string; body: string }> = {
  success: {
    icon: <CheckCircle2 className="h-12 w-12 text-green-500" />,
    title: "You're subscribed.",
    body:
      "We'll bill $99/mo plus 1× MRR per recovered win-back, refundable in full if they re-cancel within 14 days. The AI is back at work.",
  },
  pilot: {
    icon: <CheckCircle2 className="h-12 w-12 text-blue-500" />,
    title: "You're on the pilot.",
    body:
      "No billing while your pilot is active — we'll resume the standard $99/mo + 1× MRR per recovery once it ends. The AI keeps working in the meantime.",
  },
  pending: {
    icon: <CheckCircle2 className="h-12 w-12 text-slate-300" />,
    title: 'Almost there.',
    body:
      "We're finalising your subscription in the background. Head back to the dashboard — it'll be active within a moment.",
  },
}
