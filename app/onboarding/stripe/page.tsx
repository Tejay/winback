import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { CreditCard } from 'lucide-react'
import { PoweredByStripe } from '@/components/powered-by-stripe'

export default async function OnboardingStripePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  // Already connected — go straight to dashboard
  if (customer?.stripeAccountId) redirect('/dashboard')

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="px-6 py-5">
        <Logo size="sm" />
      </div>

      <div className="max-w-2xl mx-auto px-4 pb-12">
        <div className="mt-6 bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Connect your Stripe account.
          </h1>
          <p className="text-sm text-slate-500 mb-6">
            Winback reads your cancellation history and starts recovering
            customers automatically.
          </p>

          <div className="bg-slate-50 rounded-xl border border-slate-100 p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600 rounded-xl w-10 h-10 flex items-center justify-center">
                <CreditCard className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-900">Stripe</div>
                <div className="text-xs text-slate-500">
                  Subscription data &amp; cancellation events
                </div>
              </div>
            </div>
            <a
              href="/api/stripe/connect"
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
            >
              Connect Stripe
            </a>
          </div>

          <div className="mt-3 flex justify-end">
            <PoweredByStripe />
          </div>

          <div className="mt-4 space-y-3">
            {[
              'Read-only access to subscriptions and customers',
              'Detects cancellations automatically via webhooks',
              'Disconnect any time from Settings',
            ].map((text) => (
              <div key={text} className="flex items-center gap-2 text-sm text-slate-500">
                <span className="text-blue-600 font-bold text-base">✓</span>
                {text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
