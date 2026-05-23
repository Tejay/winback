import Link from 'next/link'
import { Ear, Layers, Send } from 'lucide-react'
import { StepCard } from '@/components/landing/step-card'
import { PoweredByStripe } from '@/components/powered-by-stripe'

/**
 * Three-step Listen → Match → Reach flow.
 *
 * Reflects the current product: one exit email goes out at cancellation
 * to capture why each subscriber left. The reason is classified into a
 * theme. When the merchant ships an improvement, WinbackFlow matches it
 * to stored themes and emails a single follow-up to the subscribers who
 * asked for that thing. No AI conversation, no drip, no AI reply-handling.
 */
export function HowItWorks() {
  return (
    <section id="how-it-works" className="bg-white py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        <div className="text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            How it works
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
            Three steps.
          </h2>
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900">
            One trigger.
          </h2>
          <p className="text-base sm:text-lg text-slate-500 mt-4 max-w-2xl mx-auto">
            No drip sequences. No AI replies. We email a subscriber only
            when you&rsquo;ve shipped what they asked for.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-16">
          <StepCard
            step="01"
            label="Listen"
            title="Capture every reason."
            icon={Ear}
            tint="amber"
            body="The moment a subscriber cancels on Stripe, WinbackFlow sends one short exit email asking why they left — and stores the reply alongside their plan, tenure, and account history."
            details={
              <p>
                Every cancellation lands instantly &mdash; who cancelled,
                what they were paying, how long they&rsquo;d been with
                you, and the reason they gave on the way out. That one
                exit email is the only thing the subscriber hears from
                us at this stage. After it&rsquo;s sent, WinbackFlow goes
                quiet until you ship a fix.
              </p>
            }
          />
          <StepCard
            step="02"
            label="Cluster"
            title="Group reasons into themes."
            icon={Layers}
            tint="blue"
            body="AI groups cancellations into themes you can act on — 'wanted Slack integration', 'price too high', 'missing API access' — and shows you which themes are growing."
            details={
              <>
                <p>
                  Free-text exit reasons aren&rsquo;t useful one-by-one;
                  they&rsquo;re useful as patterns. WinbackFlow rolls
                  individual cancellations into themes you can read at a
                  glance:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>How many subscribers cited each theme</li>
                  <li>How much MRR is sitting in each theme</li>
                  <li>Which themes are trending up</li>
                </ul>
                <p>
                  The themes tell you what to build &mdash; ranked by lost
                  revenue, not gut feel.
                </p>
              </>
            }
          />
          <StepCard
            step="03"
            label="Reach"
            title="Email when you ship the fix."
            icon={Send}
            tint="emerald"
            body="You log a shipped improvement that addresses a theme. WinbackFlow emails the specific subscribers who cited that theme — one targeted message each, in your name."
            details={
              <>
                <p>
                  Single email per matched subscriber. No drip. No
                  conversation. The email names exactly what they asked
                  for and what you&rsquo;ve done about it.
                </p>
                <p>
                  Sent from our verified sending domain with your name on
                  the From line. Subscriber replies route to your normal
                  inbox &mdash; WinbackFlow doesn&rsquo;t intercept or
                  auto-respond. The conversation from there is between
                  you and them.
                </p>
              </>
            }
          />
        </div>

        <div className="mt-6 flex justify-center">
          <PoweredByStripe />
        </div>

        <div className="mt-16 flex justify-center">
          <Link
            href="/register"
            className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
          >
            Start capturing reasons today →
          </Link>
        </div>
      </div>
    </section>
  )
}
