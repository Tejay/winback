import { Sparkles, Zap, RefreshCcw } from 'lucide-react'

/**
 * 3-column "what's different" grid for /win-back.
 * Mirrors the visual shape of components/payment-recovery/pillars.tsx.
 */
const PILLARS = [
  {
    icon: Sparkles,
    title: 'AI-drafted, not templated.',
    body: 'Each email is written from scratch for the subscriber in front of it — their reason, their tenure, their plan, what you’ve shipped since they signed up. No "we miss you" filler.',
  },
  {
    icon: Zap,
    title: 'Fires when the moment is right.',
    body: 'When you ship a feature that maps to why someone cancelled, Winback notices and re-engages them. When the cancel reason is just "too expensive," it stays quiet — silence is sometimes the right reply.',
  },
  {
    icon: RefreshCcw,
    title: 'One tap to reactivate.',
    body: 'Customers click a single link to resubscribe — same Stripe customer, same payment method, no re-onboarding. Replies route to your dashboard so you can read what they say back.',
  },
]

export function Pillars() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        {PILLARS.map(({ icon: Icon, title, body }) => (
          <div key={title} className="bg-white rounded-2xl border border-slate-100 p-7 shadow-sm">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
              <Icon className="w-5 h-5" strokeWidth={1.8} />
            </div>
            <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
            <p className="mt-2 text-sm text-slate-600 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
