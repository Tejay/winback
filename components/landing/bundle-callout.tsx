import { Check, CreditCard, MessageSquare } from 'lucide-react'

/**
 * Bundle callout — the dark-bordered "Winback Platform" container that visually
 * conjoins Payment Recovery + Win-back into one platform. Source:
 * marketing/home-changes-mockup.html Change #1.
 *
 * Lives on the home page, between the hero and the two-pillar teaser. The
 * outer border + single floating "Winback Platform · $99/mo" badge is the
 * key visual signal: these aren't two products you pick from, they're one
 * platform with two flows.
 */
export function BundleCallout() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6">
        <div className="text-center mb-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
          What you get
        </p>
        <h2 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
          Two flows. One platform.
        </h2>
        <p className="mt-4 text-sm text-slate-600 max-w-xl mx-auto">
          The platform fee covers payment recovery; the performance fee only kicks in when we recover a customer who actually quit. They work together, they bill together.
        </p>
      </div>

      <div className="relative">
        {/* Floating badge */}
        <div className="absolute -top-4 left-1/2 -translate-x-1/2 z-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#0f172a] text-white rounded-full text-xs font-semibold shadow-md">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Winback Platform · $99/mo
          </div>
        </div>

        <div className="bg-white border-2 border-[#0f172a] rounded-3xl p-3 shadow-md">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">

            {/* Payment Recovery card */}
            <div className="bg-slate-50 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-blue-600 text-white flex items-center justify-center">
                  <CreditCard className="w-5 h-5" strokeWidth={1.8} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Payment Recovery</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">
                When cards fail. Three perfectly-timed emails, decline-aware coaching, Apple Pay / Google Pay / Link update flow.
              </p>
              <ul className="space-y-2 text-sm text-slate-700">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Up to 500 recoveries / month</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>No per-recovery cut · No save caps within plan</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span className="text-slate-900 font-medium">Included in the platform fee</span>
                </li>
              </ul>
            </div>

            {/* Win-back card */}
            <div className="bg-slate-50 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-blue-600 text-white flex items-center justify-center">
                  <MessageSquare className="w-5 h-5" strokeWidth={1.8} />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">Win-back</h3>
              </div>
              <p className="text-sm text-slate-600 mb-4">
                When customers cancel deliberately. AI reads the reason, drafts a personalised email, fires when the product matches what they wanted.
              </p>
              <ul className="space-y-2 text-sm text-slate-700">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>AI-drafted, never templated</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>1 month&apos;s subscription fee per recovery · Refundable for 14 days</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span className="text-slate-900 font-medium">Performance-billed — $0 if we don&apos;t recover</span>
                </li>
              </ul>
            </div>
          </div>

          <div className="px-7 py-5 mt-3 border-t border-slate-100 text-center">
            <p className="text-sm text-slate-600">
              <span className="font-semibold text-slate-900">There&apos;s no half subscription.</span>{' '}
              One Stripe Connect, both flows, one bill.
            </p>
          </div>
        </div>
      </div>
      </div>
    </section>
  )
}
