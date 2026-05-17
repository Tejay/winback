import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { PoweredByStripe } from '@/components/powered-by-stripe'
import { StripeConnectCard } from '@/components/onboarding/stripe-connect-card'
import { logEvent } from '@/src/winback/lib/events'
import { Check, X, AlertCircle } from 'lucide-react'

// Known error types surfaced by /api/stripe/callback via ?error=...
// Copy deliberately reassures rather than blames the user.
const ERROR_MESSAGES: Record<string, string> = {
  denied:
    "You cancelled on Stripe's screen. No data left Stripe — come back when you're ready.",
  missing_params:
    'Something went wrong handing you back from Stripe. Try again, and email support if it persists.',
  invalid_state:
    "We couldn't match the response to your account. Please try connecting again.",
  token_exchange_failed:
    "Stripe authorised the connection but we couldn't complete it. Please try again.",
  account_already_linked:
    'This Stripe account is already connected to another Winback workspace. Connect a different Stripe account, or contact support@winbackflow.co if this is unexpected.',
}

// Permission matrix — surfaced inside the first disclosure, not above the fold.
// The confident reader skips it; the sceptic clicks and gets the full picture.
const CAN_READ = [
  'See active subscriptions',
  'See cancellations and failed payments',
  'See customer email, plan, and MRR',
  'See the cancellation reason (when Stripe captures it)',
]

const CANNOT_DO = [
  'Charge your customers',
  'Issue refunds or file disputes',
  'Change prices or plan configurations',
  'Create new subscriptions out of nowhere',
]

const WRITE_ACTIONS = [
  'Restart a cancelled subscription',
  'Fix a failed card',
]

type SearchParams = { error?: string | string[] }

export default async function OnboardingStripePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  // Already connected — go straight to dashboard.
  if (customer?.stripeAccountId) redirect('/dashboard')

  const params = await searchParams
  const rawError = Array.isArray(params.error) ? params.error[0] : params.error
  const errorType = rawError && ERROR_MESSAGES[rawError] ? rawError : undefined

  // Fire-and-forget: log this page view for the conversion funnel.
  await logEvent({
    name: 'onboarding_stripe_viewed',
    customerId: customer?.id ?? null,
    userId: session.user.id,
    properties: { hasError: !!errorType, ...(errorType ? { errorType } : {}) },
  })

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="px-6 py-5">
        <Logo size="sm" />
      </div>

      <div className="max-w-2xl mx-auto px-4 pb-12">
        <div className="mt-6 bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          {/* Eyebrow — matches the site's text-xs uppercase tracking-widest
              pattern used on every other page. Tells the user where they
              are in the flow. */}
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600 mb-3">
            Final step
          </p>

          {/* Headline carries the value (recovery) instead of restating the
              action (which is already on the CTA button below). */}
          <h1 className="text-3xl font-bold text-slate-900 mb-2">
            One last step before your first recovery.
          </h1>

          {/* Subhead tightened — was "Winback reads your cancellations and
              failed payments, and restarts subscriptions your customers
              click to restart" which had pre-emptively defensive phrasing
              ("subscriptions your customers click to restart"). The new
              version splits the same idea into two clean halves. */}
          <p className="text-sm text-slate-500 mb-2 leading-relaxed">
            Winback reads your Stripe to spot cancellations and failed
            payments. We only write back when a customer clicks to
            restart.
          </p>

          {/* Time-to-value line — sets expectation for what's coming on
              the next click so the user isn't bracing for a 10-min form. */}
          <p className="text-xs text-slate-400 mb-6 leading-relaxed">
            Takes about 30 seconds &mdash; Stripe shows you the exact
            permissions, you approve, and you&rsquo;re back here.
          </p>

          {errorType && (
            <div
              role="alert"
              className="mb-5 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />
              <div>{ERROR_MESSAGES[errorType]}</div>
            </div>
          )}

          <StripeConnectCard />

          {/* Powered-by-Stripe lockup centred directly under the CTA so it
              functions as a trust signal at the moment of decision (was
              previously right-aligned + smaller). */}
          <div className="mt-3 flex justify-center">
            <PoweredByStripe />
          </div>

          {/* Above-the-fold trust strip — hoists the most objection-killing
              copy out of the collapsed `<details>` so a scanner sees it
              without clicking. The full bulleted lists still live in the
              first disclosure below for the buyer who wants the detail. */}
          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50/60 px-5 py-4">
            <ul className="space-y-2.5 text-sm">
              <li className="flex items-start gap-2.5 text-slate-700">
                <Check className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" aria-hidden />
                <span>
                  <strong className="text-slate-900">Reads</strong>{' '}
                  subscriptions, cancellations, and failed payments.
                </span>
              </li>
              <li className="flex items-start gap-2.5 text-slate-700">
                <X className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" aria-hidden />
                <span>
                  <strong className="text-slate-900">Cannot</strong>{' '}
                  charge customers, issue refunds, or change prices.
                </span>
              </li>
              <li className="flex items-start gap-2.5 text-slate-700">
                <Check className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" aria-hidden />
                <span>
                  <strong className="text-slate-900">Disconnect</strong>{' '}
                  anytime in one click from Settings or your Stripe
                  dashboard.
                </span>
              </li>
            </ul>
          </div>

          {/* Expand-if-curious disclosures. Default to collapsed — confident
              readers connect; sceptics get the detail on demand. */}
          <section className="mt-8 divide-y divide-slate-100 border-t border-slate-100">
            <details className="group py-3">
              <summary className="cursor-pointer list-none flex items-start justify-between gap-4 text-sm font-medium text-slate-900 hover:text-blue-600">
                <span>What access does this give Winback?</span>
                <span className="text-slate-400 group-open:rotate-45 transition-transform flex-shrink-0" aria-hidden>+</span>
              </summary>
              <div className="mt-4 text-sm text-slate-600 leading-relaxed">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      We can read
                    </div>
                    <ul className="space-y-2">
                      {CAN_READ.map((item) => (
                        <li key={item} className="flex items-start gap-2 text-slate-700">
                          <Check className="w-4 h-4 text-green-600 mt-0.5 flex-shrink-0" aria-hidden />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                      We cannot
                    </div>
                    <ul className="space-y-2">
                      {CANNOT_DO.map((item) => (
                        <li key={item} className="flex items-start gap-2 text-slate-700">
                          <X className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" aria-hidden />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-5 pt-4 border-t border-slate-100">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                    We write only when your customer clicks
                  </div>
                  <ul className="space-y-2">
                    {WRITE_ACTIONS.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-slate-700">
                        <Check className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" aria-hidden />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-slate-500">
                    Stripe calls this permission <code className="text-slate-700">read_write</code>. We only use write to carry out the action your customer asked for.
                  </p>
                </div>
              </div>
            </details>

            <details className="group py-3">
              <summary className="cursor-pointer list-none flex items-start justify-between gap-4 text-sm font-medium text-slate-900 hover:text-blue-600">
                <span>What happens on Stripe&rsquo;s next screen?</span>
                <span className="text-slate-400 group-open:rotate-45 transition-transform flex-shrink-0" aria-hidden>+</span>
              </summary>
              <div className="mt-2 text-sm text-slate-600 leading-relaxed">
                Stripe shows you the exact permissions Winback is requesting
                and asks you to approve. If you cancel there, no data leaves
                Stripe and no connection is created.
              </div>
            </details>

            <details className="group py-3">
              <summary className="cursor-pointer list-none flex items-start justify-between gap-4 text-sm font-medium text-slate-900 hover:text-blue-600">
                <span>How do I revoke later?</span>
                <span className="text-slate-400 group-open:rotate-45 transition-transform flex-shrink-0" aria-hidden>+</span>
              </summary>
              <div className="mt-2 text-sm text-slate-600 leading-relaxed">
                Winback{' '}
                <Link href="/settings" className="text-blue-600 hover:underline">
                  Settings
                </Link>{' '}
                &rarr; Disconnect. Or from your Stripe dashboard &rarr; Settings &rarr; Connected apps.
              </div>
            </details>

            <details className="group py-3">
              <summary className="cursor-pointer list-none flex items-start justify-between gap-4 text-sm font-medium text-slate-900 hover:text-blue-600">
                <span>Where does my data live?</span>
                <span className="text-slate-400 group-open:rotate-45 transition-transform flex-shrink-0" aria-hidden>+</span>
              </summary>
              <div className="mt-2 text-sm text-slate-600 leading-relaxed">
                US (AWS us-east-2) under EU Standard Contractual Clauses. Full list at{' '}
                <Link href="/subprocessors" className="text-blue-600 hover:underline">
                  /subprocessors
                </Link>
                .
              </div>
            </details>
          </section>

          <div className="mt-6 pt-5 border-t border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-slate-400">
            <div>
              <Link href="/dpa" className="hover:text-slate-700">DPA</Link>
              {' · '}
              <Link href="/privacy" className="hover:text-slate-700">Privacy</Link>
              {' · '}
              <Link href="/subprocessors" className="hover:text-slate-700">Subprocessors</Link>
            </div>
            <a href="mailto:support@winbackflow.co" className="hover:text-slate-700">
              Email support
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}
