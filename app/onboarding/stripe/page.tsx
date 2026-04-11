import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { StepProgress } from '@/components/step-progress'
import { CreditCard } from 'lucide-react'
import Link from 'next/link'

export default async function OnboardingStripePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  const stripeConnected = !!customer?.stripeAccountId
  const completedSteps: number[] = []
  if (stripeConnected) completedSteps.push(1)

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="px-6 py-5">
        <Logo size="sm" />
      </div>

      <div className="max-w-2xl mx-auto px-4 pb-12">
        <StepProgress currentStep={1} completedSteps={completedSteps} />

        <div className="mt-6 bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          <span className="bg-blue-50 text-blue-700 text-xs font-semibold rounded-full px-3 py-1 inline-block mb-4">
            STEP 1 OF 4
          </span>

          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Connect your Stripe account
          </h1>
          <p className="text-sm text-slate-500 mb-6">
            One OAuth click gives Winback access to cancellation events. We
            never touch your customers&apos; payment details.
          </p>

          <div className="bg-slate-50 rounded-xl border border-slate-100 p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600 rounded-xl w-10 h-10 flex items-center justify-center">
                <CreditCard className="w-5 h-5 text-white" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-900">Stripe</div>
                <div className="text-xs text-slate-500">
                  Subscription data &amp; cancellation webhooks
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

          <div className="mt-4 space-y-3">
            {[
              'Read-only access to subscriptions and customers',
              'Real-time webhook for customer.subscription.deleted',
              'Disconnect any time from Settings',
            ].map((text) => (
              <div key={text} className="flex items-center gap-2 text-sm text-slate-500">
                <span className="text-blue-600 font-bold text-base">✓</span>
                {text}
              </div>
            ))}
          </div>

          <div className="flex justify-end mt-8">
            <Link
              href={stripeConnected ? '/onboarding/gmail' : '#'}
              className={`rounded-full px-5 py-2 text-sm font-medium ${
                stripeConnected
                  ? 'bg-[#0f172a] text-white hover:bg-[#1e293b]'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }`}
              aria-disabled={!stripeConnected}
            >
              Next: Connect Gmail &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
