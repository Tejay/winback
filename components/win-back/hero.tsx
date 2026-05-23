import { FlowIllustration } from '@/components/landing/flow-illustration'

/**
 * /win-back hero. Mirrors components/payment-recovery/hero.tsx — full-bleed
 * section with bg-#eef2fb to match the platform's hero pattern.
 *
 * The product story: an exit email goes out at cancellation to capture
 * why each subscriber left. The reason is classified into a theme. When
 * the merchant later ships an improvement that matches a theme,
 * WinbackFlow emails the specific subscribers who asked for it — one
 * targeted follow-up, no generic blast, no AI conversation back-and-forth.
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
            Every cancellation triggers a short exit email asking the
            customer why they left. WinbackFlow classifies each reply
            into a theme and remembers who asked for what.{' '}
            <span className="text-blue-600 font-semibold">
              When you later ship something that matches a theme, we
              email the specific subscribers who cited it.
            </span>{' '}
            One targeted follow-up per match &mdash; no blast, no drip.
          </p>
        </div>

        <FlowIllustration />
      </div>
    </section>
  )
}
