import { FlowIllustration } from '@/components/landing/flow-illustration'

/**
 * /win-back hero. Mirrors components/payment-recovery/hero.tsx — full-bleed
 * section with bg-#eef2fb to match the platform's hero pattern. Includes the
 * cancellation → AI → recovery flow diagram (which was on the old home hero
 * but is win-back-specific, so it lives here now).
 */
export function Hero() {
  return (
    <section className="bg-[#eef2fb] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6 flex flex-col items-center">
        <div className="max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            Win-back
          </p>
          <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
            Bring back the customers who chose to leave.
          </h1>
          <p className="mt-5 text-base sm:text-lg text-slate-600 leading-relaxed">
            Cancellations aren&apos;t the end — most customers leave because the moment was wrong, not the product. Winback reads each cancellation reason against your account history, your changelog, and the customer&apos;s tenure, then writes a personal, single email that fits.{' '}
            <span className="text-slate-900 font-medium">No templates, no broadcasts, no &quot;we&apos;d love to have you back!&quot;</span>
          </p>
        </div>

        <FlowIllustration />
      </div>
    </section>
  )
}
