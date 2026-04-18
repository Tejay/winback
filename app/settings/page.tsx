import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { DisconnectButton } from './disconnect-button'
import { DangerZone } from './danger-zone'
import { NotificationEmailForm } from './notification-email-form'
import { CreditCard } from 'lucide-react'
import { PoweredByStripe } from '@/components/powered-by-stripe'

export default async function SettingsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  const stripeConnected = !!customer?.stripeAccessToken

  return (
    <>
      <TopNav userName={session.user.name} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-6 py-8">
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
            <div className="flex items-center justify-between py-4 border-b border-slate-100">
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
              You only pay once Winback is actively recovering customers.
            </p>

            {/* Plan card */}
            <div className="border border-slate-200 rounded-2xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center">
                  <span className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Current plan
                  </span>
                  <span className="bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-3 py-1 text-xs font-semibold ml-2">
                    🌟 Free trial
                  </span>
                </div>
                <button className="bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-[#1e293b]">
                  Add payment method
                </button>
              </div>

              <div className="mt-4">
                <span className="text-3xl font-bold text-slate-900">15%</span>
                <span className="text-slate-400"> of recovered revenue</span>
              </div>
              <p className="text-sm text-slate-500 mt-2">
                For 12 months per recovered subscriber. No base fee, no cap.
              </p>
              <p className="text-xs text-slate-400 mt-3">
                No card at signup · We ask for payment after your first recovery · Cancel anytime
              </p>
            </div>

            {/* Billing contact */}
            <div className="flex items-center justify-between py-4 border-t border-slate-100 mt-4">
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

            {/* Invoices */}
            <div className="flex items-center justify-between py-4 border-t border-slate-100">
              <div>
                <div className="text-sm font-medium text-slate-900">
                  Invoices
                </div>
                <div className="text-sm text-slate-500">None yet</div>
              </div>
              <button className="text-sm text-blue-600 hover:underline">
                View history
              </button>
            </div>
          </div>

          {/* Danger zone */}
          <DangerZone paused={!!customer?.pausedAt} />
        </div>
      </main>
    </>
  )
}
