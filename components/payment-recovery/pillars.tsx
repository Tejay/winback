import { Clock, Layers, Wallet } from 'lucide-react'

/**
 * 3-column "what's different" grid. Mirrors marketing/payment-recovery-section.html §2.
 */

const PILLARS = [
  {
    icon: Clock,
    title: 'Lead Stripe’s retries.',
    body: 'Our emails land ~24 hours before every Stripe retry attempt. Three touches over three weeks, never duplicating Stripe’s own messaging — yours leads, Stripe follows.',
    highlight: '~24 hours before',
  },
  {
    icon: Layers,
    title: 'Tell them what’s actually wrong.',
    body: 'We read Stripe’s decline code and rewrite the email to match. "Your card expired" if it did. "Your bank flagged the charge" if they did. Customers know exactly what to do — instead of giving up.',
    highlight: 'Customers know exactly what to do',
  },
  {
    icon: Wallet,
    title: 'Apple Pay. Google Pay. Link.',
    body: 'Our update-payment page surfaces every wallet the customer has set up — not just card. One tap to fix. No card number to retype.',
    highlight: 'One tap to fix.',
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
