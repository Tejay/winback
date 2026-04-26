import Link from 'next/link'
import { Logo } from '@/components/logo'

export const metadata = { title: 'Pricing — Winback' }

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col">
      <nav className="pt-4 px-6">
        <div className="max-w-5xl mx-auto bg-white rounded-full px-6 flex items-center justify-between h-14 shadow-sm border border-slate-100">
          <Logo />
          <div className="flex items-center gap-6">
            <Link href="/" className="text-slate-600 text-sm">Home</Link>
            <Link href="/login" className="text-slate-600 text-sm">Log in</Link>
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
            >
              Sign up &rarr;
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1 py-24 sm:py-32">
        <div className="max-w-3xl mx-auto px-6">
          {/* Header */}
          <div className="text-center">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Pricing
            </div>
            <h1 className="mt-6 text-4xl sm:text-5xl font-bold text-slate-900 tracking-tight leading-[1.1]">
              No win-back,<br />no performance fee.
            </h1>
            <p className="mt-5 text-base text-slate-600 max-w-lg mx-auto">
              Pay $99/mo for the platform — unlimited card saves included. The
              performance fee only earns when we bring a cancelled subscriber back.
            </p>
          </div>

          {/* Pricing card — two-fee structure */}
          <div className="mt-12 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
              <div className="p-8">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400">
                  Platform
                </div>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-5xl font-bold text-slate-900 tracking-tight">$99</span>
                  <span className="text-sm text-slate-500">/mo</span>
                </div>
                <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                  Flat. Includes unlimited card saves — one or a thousand, same price.
                </p>
              </div>

              <div className="p-8 bg-slate-50/50">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-600">
                  Performance
                </div>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-5xl font-bold text-slate-900 tracking-tight">1×</span>
                  <span className="text-sm text-slate-500">MRR · once per win-back</span>
                </div>
                <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                  Charged only when a cancelled subscriber comes back. 14-day refund if
                  they re-cancel.
                </p>
              </div>
            </div>

            <div className="border-t border-slate-100" />

            <div className="p-8">
              <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-5">
                What&apos;s included
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Under 60 seconds</strong> from cancel to email
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">AI-written per subscriber</strong>, not templated
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Changelog-aware</strong> — re-engages when you ship
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Replies route to your dashboard</strong>
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Unlimited card saves</strong> when payments fail
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Live in 5 minutes</strong> — connect Stripe
                  </span>
                </div>
              </div>
            </div>

            <div className="px-8 pb-8 flex flex-col sm:flex-row sm:items-center gap-4 border-t border-slate-100 pt-6">
              <Link
                href="/register"
                className="bg-[#0f172a] text-white rounded-full px-6 py-3 text-sm font-medium hover:bg-[#1e293b] inline-flex items-center gap-2"
              >
                Start recovering revenue →
              </Link>
              <p className="text-xs text-slate-500">
                No card at signup. Billing starts after your first save or win-back.
              </p>
            </div>
          </div>

          {/* Worked example with ROI */}
          <div className="mt-10 rounded-2xl bg-white border border-slate-200 overflow-hidden">
            <div className="px-6 sm:px-8 py-5 border-b border-slate-100 flex items-baseline justify-between">
              <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-600">
                A typical month
              </div>
              <div className="text-xs text-slate-400">Sub MRR: $25 avg</div>
            </div>
            <dl className="text-sm">
              <div className="flex justify-between px-6 sm:px-8 py-4 border-b border-slate-100">
                <dt className="text-slate-700">Platform fee</dt>
                <dd className="text-slate-900 font-medium tabular-nums">$99</dd>
              </div>
              <div className="flex justify-between px-6 sm:px-8 py-4 border-b border-slate-100">
                <dt className="text-slate-700">40 card saves</dt>
                <dd className="text-green-700 font-medium">included</dd>
              </div>
              <div className="flex justify-between px-6 sm:px-8 py-4 border-b border-slate-100">
                <dt className="text-slate-700">
                  3 cancellers won back <span className="text-slate-400">($25 × 3)</span>
                </dt>
                <dd className="text-slate-900 font-medium tabular-nums">$75</dd>
              </div>
              <div className="flex justify-between px-6 sm:px-8 py-5 bg-slate-50">
                <dt className="text-slate-900 font-semibold">You pay this month</dt>
                <dd className="text-slate-900 font-bold text-base tabular-nums">$174</dd>
              </div>
            </dl>

            <div className="px-6 sm:px-8 py-6 bg-gradient-to-br from-blue-50 to-blue-50/40 border-t border-blue-100">
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-700">
                    If those 3 stay 12 months
                  </div>
                  <div className="mt-1 text-sm text-slate-600">$25 × 3 × 12 months recovered</div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-bold text-slate-900 tabular-nums">$900</div>
                  <div className="text-xs text-slate-500">kept revenue</div>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-blue-200/60 flex items-baseline justify-between gap-4">
                <div className="text-sm text-slate-700">Return on the $75 win-back fee</div>
                <div className="text-2xl font-bold text-blue-700 tabular-nums">12×</div>
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-slate-400 italic px-1">
            Card-save revenue not included above.
          </p>

          {/* Scale strip — same model at other business sizes */}
          <div className="mt-6 text-[11px] font-semibold tracking-widest uppercase text-slate-400 px-1">
            And at other scales
          </div>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-5">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400">Indie</div>
                <div className="text-xs text-slate-500 tabular-nums">$19 MRR</div>
              </div>
              <div className="mt-1 text-xs text-slate-500">2 win-backs · 25 saves</div>
              <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">Monthly</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">$137</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$99 + 2 × $19</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">12-mo recovered</div>
                  <div className="mt-0.5 text-lg font-bold text-blue-700 tabular-nums">$456</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$19 × 2 × 12</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white border-2 border-blue-200 p-5">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-700">SMB · shown above</div>
                <div className="text-xs text-slate-500 tabular-nums">$25 MRR</div>
              </div>
              <div className="mt-1 text-xs text-slate-500">3 win-backs · 40 saves</div>
              <div className="mt-4 pt-4 border-t border-blue-100 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">Monthly</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">$174</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$99 + 3 × $25</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">12-mo recovered</div>
                  <div className="mt-0.5 text-lg font-bold text-blue-700 tabular-nums">$900</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$25 × 3 × 12</div>
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-5">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400">Mid-market</div>
                <div className="text-xs text-slate-500 tabular-nums">$89 MRR</div>
              </div>
              <div className="mt-1 text-xs text-slate-500">4 win-backs · 30 saves</div>
              <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">Monthly</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">$455</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$99 + 4 × $89</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">12-mo recovered</div>
                  <div className="mt-0.5 text-lg font-bold text-blue-700 tabular-nums">$4,272</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$89 × 4 × 12</div>
                </div>
              </div>
            </div>
          </div>

          {/* Trust strip */}
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-x-8 gap-y-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="text-green-600">✓</span> Cancel anytime
            </span>
            <span className="text-slate-300 hidden sm:inline">·</span>
            <span className="flex items-center gap-1.5">
              <span className="text-green-600">✓</span> 14-day refund on performance fee
            </span>
            <span className="text-slate-300 hidden sm:inline">·</span>
            <span className="flex items-center gap-1.5">
              <span className="text-green-600">✓</span> No setup fees
            </span>
          </div>

          {/* How billing works — extra detail block, only on dedicated page */}
          <div className="mt-16 max-w-2xl mx-auto">
            <div className="text-xs font-semibold tracking-widest uppercase text-slate-400 pb-3 border-b border-slate-200">
              How billing works
            </div>
            <dl className="divide-y divide-slate-100 text-sm">
              <div className="py-4">
                <dt className="text-slate-900 font-medium">When does the $99 start?</dt>
                <dd className="mt-1 text-slate-600 leading-relaxed">
                  After we deliver your first card save or win-back, whichever comes
                  first. We don&apos;t bill the platform fee at signup — it kicks in
                  once we&apos;ve actually saved you a dollar.
                </dd>
              </div>
              <div className="py-4">
                <dt className="text-slate-900 font-medium">How is the performance fee charged?</dt>
                <dd className="mt-1 text-slate-600 leading-relaxed">
                  One invoice per win-back, equal to one month of that subscriber&apos;s MRR.
                  Charged once — never recurring. If they re-cancel within 14 days, we
                  refund the fee in full.
                </dd>
              </div>
              <div className="py-4">
                <dt className="text-slate-900 font-medium">What counts as a win-back?</dt>
                <dd className="mt-1 text-slate-600 leading-relaxed">
                  A subscriber who actively cancelled and then reactivated their
                  subscription within our attribution window. Failed-payment recoveries
                  are <em>not</em> win-backs — those are covered by the platform fee.
                </dd>
              </div>
              <div className="py-4">
                <dt className="text-slate-900 font-medium">What if no cancellations happen?</dt>
                <dd className="mt-1 text-slate-600 leading-relaxed">
                  You still pay $99/mo — your card saves alone justify the platform
                  fee. The performance fee just doesn&apos;t add anything that month.
                  If neither saves nor cancellations happen, the $99 doesn&apos;t
                  kick in until they do.
                </dd>
              </div>
            </dl>
          </div>

          {/* Fixed-contract alternative */}
          <div className="mt-16 max-w-xl mx-auto pt-10 border-t border-slate-200 text-center">
            <h3 className="text-sm font-semibold text-slate-900">
              Need a fixed annual contract?
            </h3>
            <p className="mt-3 text-sm text-slate-500 leading-relaxed">
              For teams that need predictable budgeting with SSO and a signed SLA —
              we offer fixed annual contracts as an alternative to the performance model.
            </p>
            <a
              href="mailto:sales@winbackflow.co"
              className="mt-4 inline-block text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              sales@winbackflow.co →
            </a>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-start justify-between gap-6 text-xs text-slate-500">
          <div className="leading-relaxed">
            <div>© {new Date().getFullYear()} Winback Ltd · Company no. {'{TO_FILL}'}</div>
            <div>{'{Registered office address — pending incorporation}'}</div>
            <div>
              <a href="mailto:support@winbackflow.co" className="hover:text-slate-900">
                support@winbackflow.co
              </a>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
            <Link href="/faq" className="hover:text-slate-900">FAQ</Link>
            <Link href="/contact" className="hover:text-slate-900">Contact</Link>
            <Link href="/refunds" className="hover:text-slate-900">Refunds</Link>
            <Link href="/aup" className="hover:text-slate-900">Acceptable Use</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
            <Link href="/dpa" className="hover:text-slate-900">DPA</Link>
            <Link href="/subprocessors" className="hover:text-slate-900">Subprocessors</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
