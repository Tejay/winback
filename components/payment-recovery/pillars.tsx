import { Clock, Layers, Wallet } from 'lucide-react'

/**
 * 3-column "what's different" grid — claim-only menu. Each pillar is a
 * scan anchor for the section that proves it later on the page (Timeline
 * proves "Lead Stripe's retries", EmailComparison proves "Tell them
 * what's wrong", CheckoutMockup proves "Apple Pay / Google Pay / Link").
 * Body text dropped per founder review — proof immediately follows the
 * claim, no need to preview it twice.
 */

const PILLARS = [
  { icon: Clock,  title: 'Lead Stripe’s retries.' },
  { icon: Layers, title: 'Tell them what’s actually wrong.' },
  { icon: Wallet, title: 'Apple Pay. Google Pay. Link.' },
]

export function Pillars() {
  return (
    <section className="bg-[#f5f5f5] py-16 sm:py-20">
      <div className="max-w-5xl mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-6">
        {PILLARS.map(({ icon: Icon, title }) => (
          <div key={title} className="bg-white rounded-2xl border border-slate-100 p-6 shadow-sm flex items-center gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center flex-shrink-0">
              <Icon className="w-5 h-5" strokeWidth={1.8} />
            </div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          </div>
        ))}
      </div>
    </section>
  )
}
