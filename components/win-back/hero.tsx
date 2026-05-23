import { FlowIllustration } from '@/components/landing/flow-illustration'

/**
 * /win-back hero. Mirrors components/payment-recovery/hero.tsx — full-bleed
 * section with bg-#eef2fb to match the platform's hero pattern.
 *
 * The new product story: AI is listen-only. It classifies why each
 * subscriber cancelled and stores the reason. When the merchant ships
 * an improvement that matches a stored reason, WinbackFlow emails the
 * specific subscribers who asked for it — one targeted message, no
 * generic blast, no AI conversation back-and-forth.
 */
export function Hero() {
  return (
    <section className="bg-[#eef2fb] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6 flex flex-col items-center">
        <div className="max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            Cancellation winbacks
          </p>
          <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
            Bring back the customers who told you why they left.
          </h1>
          <p className="mt-5 text-base sm:text-lg text-slate-600 leading-relaxed">
            Every cancellation comes with a reason &mdash; in the Stripe
            cancel box, in the customer&rsquo;s own words. WinbackFlow
            reads each one, classifies it into a theme, and remembers
            who asked for what.{' '}
            <span className="text-blue-600 font-semibold">
              When you ship something that matches a theme, we email the
              specific subscribers who cited it.
            </span>{' '}
            One targeted message per match &mdash; no blast, no drip.
          </p>
        </div>

        <FlowIllustration />
      </div>
    </section>
  )
}
