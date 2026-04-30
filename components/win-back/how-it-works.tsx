import Link from 'next/link'
import { Zap, Brain, Send } from 'lucide-react'
import { StepCard } from '@/components/landing/step-card'
import { PoweredByStripe } from '@/components/powered-by-stripe'

/**
 * Three-step Detect → Decide → Act flow. Ported from the previous home page
 * (app/page.tsx:60-169 in the pre-marketing-reorg version) — this is the
 * native home of the win-back deep dive.
 *
 * No <RevealOnScroll /> wrapper: same fix as DashboardProof. The step cards
 * are the centrepiece of the section and should render solid on first paint
 * — fast scrolls past the section could leave them mid-fade or trigger-less.
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
            Zero manual work.
          </h2>
          <p className="text-base sm:text-lg text-slate-500 mt-4 max-w-2xl mx-auto">
            No fixed workflows, no generic templates. Every email is written
            from scratch for the subscriber in front of it.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-16">
          <StepCard
            step="01"
            label="Detect"
            title="Catch every cancellation."
            icon={Zap}
            tint="amber"
            body="The moment a subscriber cancels on Stripe, Winback picks it up — with the customer, plan, and exit reason attached."
            details={
              <p>
                Every cancellation lands in Winback the second it happens
                — who cancelled, what they were paying, how long
                they&rsquo;d been a customer, and any reason they gave
                (including whatever they typed in Stripe&rsquo;s cancel
                box).
              </p>
            }
          />
          <StepCard
            step="02"
            label="Decide"
            title="Read the full situation."
            icon={Brain}
            tint="blue"
            body="AI weighs the exit reason, account history, tenure, and product fit — then picks the angle most likely to bring them back."
            details={
              <>
                <p>
                  Winback reads the cancellation reason against what
                  you&rsquo;ve shipped since they subscribed, their tenure,
                  their plan, and the signal strength of the feedback. From
                  there it picks the response that actually fits:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Accountability when it&rsquo;s a quality issue</li>
                  <li>Education when they missed a feature</li>
                  <li>A genuine update when something has changed</li>
                  <li>Silence when contact would do more harm than good</li>
                </ul>
              </>
            }
          />
          <StepCard
            step="03"
            label="Act"
            title="Send the email that fits."
            icon={Send}
            tint="emerald"
            body="A personalised message tailored to their exact situation. Replies route to your inbox. Not a generic drip. Not a blast."
            details={
              <>
                <p>
                  One email per cancellation, written from scratch. Sent
                  with your name on the From line, from our verified
                  sending domain.
                </p>
                <p>
                  When a subscriber replies, the same AI reads it —
                  new context (they changed their mind, clarified a reason,
                  pushed back) flows back in and tunes the next move. You
                  see the reply and the updated classification in your
                  Winback dashboard.
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
            Start recovering customers today →
          </Link>
        </div>
      </div>
    </section>
  )
}
