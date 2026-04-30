import Link from 'next/link'
import { ArrowRight, CreditCard, MessageSquare } from 'lucide-react'

/**
 * Two side-by-side teaser cards on the home page. Each one is a clickable
 * link to its dedicated deep page (/payment-recovery or /win-back).
 *
 * Replaces the legacy "How It Works" + card-recovery sections on home —
 * those deep stories now live on the dedicated pages. Home keeps it tight.
 */

const TEASERS = [
  {
    href: '/payment-recovery',
    icon: CreditCard,
    eyebrow: 'Payment recovery',
    title: 'When cards fail.',
    body: 'Three perfectly-timed emails that lead Stripe’s retries by 24 hours. Decline-aware copy that knows why the card failed. One-tap update with Apple Pay, Google Pay, Link.',
    cta: 'See how payment recovery works',
  },
  {
    href: '/win-back',
    icon: MessageSquare,
    eyebrow: 'Win-back',
    title: 'When customers cancel.',
    body: 'AI reads each cancellation reason against your product, your changelog, and the customer’s history — then writes the single email most likely to bring them back. Or stays silent when contact would do harm.',
    cta: 'See how win-back works',
  },
]

export function TwoPillarTeaser() {
  return (
    <section className="bg-white py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {TEASERS.map(({ href, icon: Icon, eyebrow, title, body, cta }) => (
          <Link
            key={href}
            href={href}
            className="group bg-white rounded-2xl border border-slate-100 p-7 shadow-sm hover:shadow-md hover:border-slate-200 transition"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
                <Icon className="w-5 h-5" strokeWidth={1.8} />
              </div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
                {eyebrow}
              </p>
            </div>
            <h3 className="mt-4 text-2xl font-bold tracking-tight text-slate-900">
              {title}
            </h3>
            <p className="mt-3 text-sm text-slate-600 leading-relaxed">{body}</p>
            <div className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 group-hover:gap-2.5 transition-all">
              {cta}
              <ArrowRight className="w-4 h-4" strokeWidth={2} />
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
