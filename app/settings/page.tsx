import { redirect } from 'next/navigation'
import { auth, userIsAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { ImpersonationBanner } from '@/components/impersonation-banner'
import { DisconnectButton } from './disconnect-button'
import { DangerZone } from './danger-zone'
import { NotificationEmailForm } from './notification-email-form'
import { PaymentMethodSection } from './payment-method-section'
import { InvoiceList } from './invoice-list'
import { CreditCard } from 'lucide-react'
import { PoweredByStripe } from '@/components/powered-by-stripe'
import { fetchPlatformPaymentMethod, fetchPlatformInvoices } from '@/src/winback/lib/platform-billing'
import { getSubscriptionDetails } from '@/src/winback/lib/subscription'
import { SubscriptionActions } from './subscription-actions'

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const isAdmin = await userIsAdmin(session.user.id)

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  const stripeConnected = !!customer?.stripeAccessToken

  // Spec 23 — fetch platform payment method for the billing section
  const paymentMethod = await fetchPlatformPaymentMethod(
    customer?.stripePlatformCustomerId ?? null,
  )
  const { billing } = await searchParams
  const billingStatus: 'success' | 'cancelled' | null =
    billing === 'success' ? 'success' : billing === 'cancelled' ? 'cancelled' : null

  // Spec 24b — fetch invoice history
  const invoices = await fetchPlatformInvoices(
    customer?.stripePlatformCustomerId ?? null,
    12,
  )

  // Subscription detail (status + cancel-at-period-end + cycle end) — drives
  // the Cancel/Resume controls and the payment-failed banner.
  const subscriptionDetails = customer?.stripeSubscriptionId
    ? await getSubscriptionDetails(customer.id)
    : null
  const paymentFailing =
    subscriptionDetails?.status === 'past_due' ||
    subscriptionDetails?.status === 'unpaid'

  // 2026-05-18 fix — display state derived from the LIVE Stripe
  // subscription status, not from `customer.stripeSubscriptionId`
  // alone. Before this, the badge ladder used "is there a sub ID
  // stored in our DB?" as the proxy for active, so a sub that
  // Stripe transitioned to `incomplete_expired`, `canceled`,
  // `past_due` etc. (without us nulling the DB field) still
  // displayed as "Active" with the green badge. Founder-facing
  // bug: merchants whose subs silently expired would think their
  // account was fine. Demo workspace incident:
  // sub_1TWPQc4G... in `incomplete_expired` displaying "Active".
  const billingDisplay = deriveBillingDisplay(
    subscriptionDetails?.status ?? null,
    subscriptionDetails?.cancelAtPeriodEnd ?? false,
    customer?.activatedAt ?? null,
    invoices.length,
  )
  // Serialize Date → ISO string for passing to client component
  const invoicesSerialized = invoices.map(inv => ({
    ...inv,
    createdAt: inv.createdAt.toISOString(),
  }))

  return (
    <>
      <ImpersonationBanner />
      <TopNav userName={session.user.name} isAdmin={isAdmin} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          {/* Page header */}
          <div className="mb-6">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Workspace
            </div>
            <h1 className="text-4xl font-bold text-slate-900">Settings.</h1>
            <p className="text-sm text-slate-500 mt-1">
              Connections, plan, and the voice of your winback emails.
            </p>
          </div>

          {/* Section 1 — Integrations */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 mb-4">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Integrations
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-1">
              Connected accounts
            </h2>
            <p className="text-sm text-slate-500 mt-1 mb-6">
              These power Winback. Reconnect or disconnect at any time.
            </p>

            {/* Stripe row */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-4 gap-3 sm:gap-4 border-b border-slate-100">
              <div className="flex items-center gap-4">
                <div className="bg-blue-600 rounded-xl w-10 h-10 flex items-center justify-center">
                  <CreditCard className="w-5 h-5 text-white" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium text-slate-900">Stripe</div>
                    <PoweredByStripe />
                  </div>
                  <div className="text-xs text-slate-500">
                    Receives cancellation webhooks
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {stripeConnected ? (
                  <>
                    <span className="bg-green-50 text-green-700 border border-green-200 rounded-full px-2.5 py-0.5 text-xs font-medium">
                      ● Connected
                    </span>
                    <DisconnectButton service="stripe" />
                  </>
                ) : (
                  <>
                    <span className="bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2.5 py-0.5 text-xs font-medium">
                      ⚠ Not connected
                    </span>
                    <a
                      href="/api/stripe/connect"
                      className="bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-[#1e293b]"
                    >
                      Connect
                    </a>
                  </>
                )}
              </div>
            </div>

          </div>

          {/* Section 1.5 — Notifications (spec 21c) */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 mb-4">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Notifications
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-1">
              Where we reach you
            </h2>
            <p className="text-sm text-slate-500 mt-1 mb-4">
              When the AI hands off a subscriber for personal follow-up, we'll send the alert here.
            </p>
            <NotificationEmailForm
              initial={customer?.notificationEmail ?? null}
              fallbackEmail={session.user.email ?? null}
            />
          </div>

          {/* Section 2 — Billing */}
          <div id="billing" className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Billing
            </div>
            <h2 className="text-lg font-semibold text-slate-900 mt-1">
              Subscription
            </h2>
            <p className="text-sm text-slate-500 mt-1 mb-6">
              {billingDisplay.caption}
            </p>

            {/* Payment-failed banner — shown when Stripe Subscription is
                past_due or unpaid. Stripe Smart Retries will keep trying;
                meanwhile the customer can update their card via the
                Payment method section below. */}
            {paymentFailing && (
              <div className="mb-5 border border-rose-200 bg-rose-50 rounded-xl p-4">
                <div className="text-sm font-semibold text-rose-900">
                  Your last payment failed.
                </div>
                <p className="text-sm text-rose-800 mt-1 leading-relaxed">
                  Stripe will retry over the next few days. To avoid
                  interruption, update your payment method below before the
                  retries are exhausted.
                </p>
              </div>
            )}

            {/* Plan card — Phase B: $99/mo platform + 1× MRR per win-back.
                Badge + footer derived from billingDisplay (see
                deriveBillingDisplay() below), which reads the LIVE
                Stripe subscription status instead of just "is there a
                sub ID stored in our DB?" — the latter was wrong for
                any sub that Stripe transitioned to incomplete_expired
                / canceled / past_due without us nulling our DB field. */}
            <div className="border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center">
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                  Current plan
                </span>
                <span className={`${billingDisplay.badge.classes} rounded-full px-3 py-1 text-xs font-semibold ml-2`}>
                  {billingDisplay.badge.label}
                </span>
              </div>

              <div className="mt-4">
                <span className="text-3xl font-bold text-slate-900">$99</span>
                <span className="text-slate-400">/mo platform fee</span>
              </div>
              <p className="text-sm text-slate-500 mt-2">
                Includes up to 500 payment recoveries per month. Plus a one-time fee of <strong className="text-slate-900">1× whatever your customer&apos;s first paid invoice is</strong> per win-back, charged when that invoice settles. If they never pay, neither do you. Fully refundable if the customer re-cancels within 14 days.
              </p>
              {billingDisplay.footer && (
                <p className="text-xs text-slate-400 mt-3">
                  {billingDisplay.footer}
                </p>
              )}

              {/* Cancel / Resume controls — visible only when a Stripe
                  Subscription is on file and in an active state. */}
              {subscriptionDetails && billingDisplay.showCancelControl && (
                <SubscriptionActions
                  status={subscriptionDetails.status ?? 'unknown'}
                  cancelAtPeriodEnd={subscriptionDetails.cancelAtPeriodEnd}
                  currentPeriodEndIso={
                    subscriptionDetails.currentPeriodEnd?.toISOString() ?? null
                  }
                />
              )}
            </div>

            {/* Payment method (spec 23) */}
            <div className="py-4 border-t border-slate-100 mt-4">
              <div className="text-sm font-medium text-slate-900 mb-2">
                Payment method
              </div>
              <PaymentMethodSection
                paymentMethod={paymentMethod}
                billingStatus={billingStatus}
              />
            </div>

            {/* Billing contact */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-4 border-t border-slate-100 mt-4">
              <div>
                <div className="text-sm font-medium text-slate-900">
                  Billing contact
                </div>
                <div className="text-sm text-slate-500">
                  {session.user.email}
                </div>
              </div>
              <button className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium">
                Update
              </button>
            </div>

            {/* Invoices (spec 24b) */}
            <div className="py-4 border-t border-slate-100">
              <div className="text-sm font-medium text-slate-900 mb-3">
                Invoices
              </div>
              <InvoiceList
                invoices={invoicesSerialized}
                hasBillingAccount={!!customer?.stripePlatformCustomerId}
              />
            </div>
          </div>

          {/* Danger zone */}
          <DangerZone
            pausedWinback={!!customer?.pausedAt}
            pausedDunning={!!customer?.pausedDunningAt}
          />
        </div>
      </main>
    </>
  )
}

/**
 * Visual state for the Billing card, derived from the live Stripe
 * subscription status. Returns a single object so the JSX stays as a
 * single ladder instead of four parallel ones.
 *
 * Inputs:
 *   stripeStatus       — sub status from getSubscriptionDetails(), or
 *                        null when there's no sub on file
 *   cancelAtPeriodEnd  — true when an active sub has a cancel queued
 *                        for cycle-end
 *   activatedAt        — when activation completed (legacy proxy used
 *                        in pre-2026-05-18 no-sub fallback paths)
 *   invoiceCount       — to distinguish "never billed" from "billed
 *                        in the past then cancelled"
 *
 * Returns:
 *   badge.label       — short status label for the pill in the plan card
 *   badge.classes     — Tailwind classes for the pill background/border
 *   caption           — top-line copy ("Your billing is active.", etc.)
 *   footer            — small footer text under the price; null hides it
 *   showCancelControl — should we render <SubscriptionActions>?
 *                       Only true for active/trialing — see
 *                       subscription-actions.tsx which double-guards.
 */
type BillingDisplay = {
  badge:   { label: string; classes: string }
  caption: string
  footer:  string | null
  showCancelControl: boolean
}

function deriveBillingDisplay(
  stripeStatus: string | null,
  cancelAtPeriodEnd: boolean,
  activatedAt: Date | null,
  invoiceCount: number,
): BillingDisplay {
  const greenBadge  = 'bg-green-50 text-green-700 border border-green-200'
  const amberBadge  = 'bg-amber-50 text-amber-700 border border-amber-200'
  const roseBadge   = 'bg-rose-50  text-rose-700  border border-rose-200'
  const slateBadge  = 'bg-slate-100 text-slate-600 border border-slate-200'
  const blueBadge   = 'bg-blue-50  text-blue-700  border border-blue-200'

  // When a sub IS on file, status drives everything.
  if (stripeStatus !== null) {
    switch (stripeStatus) {
      case 'active':
      case 'trialing':
        return cancelAtPeriodEnd
          ? {
              badge:   { label: 'Cancelling', classes: amberBadge },
              caption: 'Your subscription will end at the cycle close.',
              footer:  'Resume any time before cycle end to keep billing uninterrupted.',
              showCancelControl: true,
            }
          : {
              badge:   { label: 'Active', classes: greenBadge },
              caption: 'Your billing is active.',
              footer:  activatedAt
                ? `Active since ${activatedAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · Cancel anytime`
                : 'Cancel anytime',
              showCancelControl: true,
            }
      case 'past_due':
        return {
          badge:   { label: 'Payment failed', classes: roseBadge },
          caption: "We're trying to bill you but the last payment failed. Update your payment method below.",
          footer:  'Stripe will keep retrying for a few days before the subscription is suspended.',
          showCancelControl: false,
        }
      case 'unpaid':
        return {
          badge:   { label: 'Suspended', classes: roseBadge },
          caption: 'Your subscription is suspended because retries were exhausted. Update your payment method below to restore service.',
          footer:  null,
          showCancelControl: false,
        }
      case 'incomplete':
        return {
          badge:   { label: 'Setup incomplete', classes: amberBadge },
          caption: "Your subscription is awaiting its first payment. Update your payment method below if needed.",
          footer:  null,
          showCancelControl: false,
        }
      case 'incomplete_expired':
        return {
          badge:   { label: 'Setup failed', classes: slateBadge },
          caption: "The initial subscription setup didn't complete in time. Contact support to start a fresh subscription.",
          footer:  null,
          showCancelControl: false,
        }
      case 'canceled':
        return {
          badge:   { label: 'Cancelled', classes: slateBadge },
          caption: 'Subscription cancelled. Re-subscribe by adding a payment method on a future recovery.',
          footer:  'Past invoices remain visible below.',
          showCancelControl: false,
        }
      case 'paused':
        return {
          badge:   { label: 'Paused', classes: blueBadge },
          caption: 'Your subscription is paused.',
          footer:  null,
          showCancelControl: false,
        }
      default:
        // Unknown Stripe status — be honest about it so support can dig in.
        return {
          badge:   { label: stripeStatus, classes: slateBadge },
          caption: `Subscription is in an unexpected state (${stripeStatus}). Please contact support@winbackflow.co.`,
          footer:  null,
          showCancelControl: false,
        }
    }
  }

  // No sub on file — fall back to legacy ladder based on activation +
  // invoice history (matches pre-fix behaviour for these paths).
  if (invoiceCount > 0) {
    return {
      badge:   { label: 'Cancelled', classes: slateBadge },
      caption: 'Subscription cancelled. Reactivate any time by adding a payment method on a future recovery.',
      footer:  'Past invoices remain visible below.',
      showCancelControl: false,
    }
  }
  if (activatedAt) {
    return {
      badge:   { label: 'Awaiting card', classes: amberBadge },
      caption: 'Add a payment method to start billing for your delivered recovery.',
      footer:  'Recovery delivered · Add a payment method below to start billing',
      showCancelControl: false,
    }
  }
  return {
    badge:   { label: 'Free until first delivery', classes: blueBadge },
    caption: 'No charge until we deliver your first save or win-back.',
    footer:  'No card at signup · Billing starts after your first save or win-back · Cancel anytime',
    showCancelControl: false,
  }
}
