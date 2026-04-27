import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
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
  // Serialize Date → ISO string for passing to client component
  const invoicesSerialized = invoices.map(inv => ({
    ...inv,
    createdAt: inv.createdAt.toISOString(),
  }))

  return (
    <>
      <TopNav userName={session.user.name} />
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
              {customer?.stripeSubscriptionId
                ? 'Your billing is active.'
                : invoices.length > 0
                ? 'Subscription canceled. Reactivate any time by adding a payment method on a future recovery.'
                : customer?.activatedAt
                ? 'Add a payment method to start billing for your delivered recovery.'
                : 'No charge until we deliver your first save or win-back.'}
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
                Badge derived from a small ladder of signals so the cancelled
                state (sub gone, but invoice history) is distinguishable from
                the never-activated state and the awaiting-card state. */}
            <div className="border border-slate-200 rounded-2xl p-5">
              <div className="flex items-center">
                <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                  Current plan
                </span>
                {customer?.stripeSubscriptionId ? (
                  <span className="bg-green-50 text-green-700 border border-green-200 rounded-full px-3 py-1 text-xs font-semibold ml-2">
                    Active
                  </span>
                ) : invoices.length > 0 ? (
                  <span className="bg-slate-100 text-slate-600 border border-slate-200 rounded-full px-3 py-1 text-xs font-semibold ml-2">
                    Canceled
                  </span>
                ) : customer?.activatedAt ? (
                  <span className="bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-3 py-1 text-xs font-semibold ml-2">
                    Awaiting card
                  </span>
                ) : (
                  <span className="bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-3 py-1 text-xs font-semibold ml-2">
                    Free until first delivery
                  </span>
                )}
              </div>

              <div className="mt-4">
                <span className="text-3xl font-bold text-slate-900">$99</span>
                <span className="text-slate-400">/mo platform fee</span>
              </div>
              <p className="text-sm text-slate-500 mt-2">
                Includes unlimited card saves. Plus a one-time fee of <strong className="text-slate-900">1× MRR</strong> per voluntary-cancellation win-back, refundable if they re-cancel within 14 days.
              </p>
              {customer?.stripeSubscriptionId && customer?.activatedAt && (
                <p className="text-xs text-slate-400 mt-3">
                  Active since{' '}
                  {customer.activatedAt.toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                  {' · Cancel anytime'}
                </p>
              )}
              {!customer?.stripeSubscriptionId && invoices.length > 0 && (
                <p className="text-xs text-slate-400 mt-3">
                  Subscription canceled · Past invoices remain visible below
                </p>
              )}
              {!customer?.stripeSubscriptionId && !customer?.activatedAt && invoices.length === 0 && (
                <p className="text-xs text-slate-400 mt-3">
                  No card at signup · Billing starts after your first save or win-back · Cancel anytime
                </p>
              )}
              {!customer?.stripeSubscriptionId && customer?.activatedAt && invoices.length === 0 && (
                <p className="text-xs text-slate-400 mt-3">
                  Recovery delivered · Add a payment method below to start billing
                </p>
              )}

              {/* Cancel / Resume controls — visible only when a Stripe
                  Subscription is on file and in an active state. */}
              {subscriptionDetails && (
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
          <DangerZone paused={!!customer?.pausedAt} />
        </div>
      </main>
    </>
  )
}
