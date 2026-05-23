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
import { commitActivation, type CommitActivationState } from '@/src/winback/lib/activation'
import { getPausedQueueCounts, type QueueCounts } from '@/src/winback/lib/pause-drain'
import type { TierKey } from '@/src/winback/lib/tiers'

const ALLOWED_TIERS = new Set(['starter', 'growth', 'scale', 'custom'])

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
  searchParams: Promise<{ session_id?: string; already_active?: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const { session_id: sessionId, already_active: alreadyActive } = await searchParams

  const [customer] = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      recommendedTier: customers.recommendedTier,
    })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  // Fallback state when we can't map the user to a customer. Either the
  // session is stale or the redirect was tampered with; direct back to
  // the dashboard and let the webhook catch up.
  if (!customer) {
    return <Shell tone="pending" />
  }

  // `already_active=1` is the activate-page client's shortcut when
  // commitActivation succeeded synchronously (card was already on file).
  // Render the success state without a second commit attempt.
  if (alreadyActive === '1') {
    return <Shell tone="success" queueCounts={await safeQueueCounts(customer.id)} />
  }

  if (!sessionId) {
    return <Shell tone="pending" />
  }

  let outcome: CommitActivationState | { state: 'error' } = { state: 'error' }

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

    // Tier resolution: prefer the value the customer confirmed on the
    // activation page (round-tripped via Checkout metadata). Fall back
    // to recommendedTier — for the legacy settings-page card-update
    // flow that never visited /billing/activate.
    const fromMetadata = checkoutSession.metadata?.winback_confirmed_tier
    const confirmedTier =
      fromMetadata && ALLOWED_TIERS.has(fromMetadata)
        ? (fromMetadata as TierKey | 'custom')
        : (customer.recommendedTier as TierKey | 'custom' | null)

    if (!confirmedTier) {
      // Customer has no recommended tier yet (probably the card-update
      // path before they've ever delivered a recovery). Render success
      // — the card is on file, we'll subscribe when a recovery lands.
      return <Shell tone="success" queueCounts={await safeQueueCounts(customer.id)} />
    }

    outcome = await commitActivation(customer.id, confirmedTier)
  } catch (err) {
    console.error('[billing/success] sync activation failed:', err)
    outcome = { state: 'error' }
  }

  // Spec 54 — once activation has run (state=active), look up the paused-
  // window queue counts so we can surface "we're processing N events…".
  let queueCounts: QueueCounts | null = null
  if (outcome.state === 'active') {
    queueCounts = await safeQueueCounts(customer.id)
  }

  if (outcome.state === 'active') return <Shell tone="success" queueCounts={queueCounts} />
  if (outcome.state === 'pilot') return <Shell tone="pilot" />
  return <Shell tone="pending" />
}

async function safeQueueCounts(customerId: string): Promise<QueueCounts | null> {
  try {
    return await getPausedQueueCounts(customerId)
  } catch (err) {
    console.warn('[billing/success] queue counts lookup failed:', err)
    return null
  }
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
      "Flat monthly fee, no per-recovery charges. Cancel anytime from your billing settings — no retention friction. WinbackFlow is back at work.",
  },
  pilot: {
    icon: <CheckCircle2 className="h-12 w-12 text-blue-500" />,
    title: "You're on the pilot.",
    body:
      "No billing while your pilot is active — once it ends, we'll prompt you to subscribe at the tier that matches your then-current MRR. WinbackFlow keeps working in the meantime.",
  },
  pending: {
    icon: <CheckCircle2 className="h-12 w-12 text-slate-300" />,
    title: 'Almost there.',
    body:
      "We're finalising your subscription in the background. Head back to the dashboard — it'll be active within a moment.",
  },
}
