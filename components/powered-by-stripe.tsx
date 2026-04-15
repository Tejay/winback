/**
 * "Powered by Stripe" lockup — required on any surface that initiates a
 * Stripe flow (per Stripe Connect branding guidelines).
 *
 * The wordmark below is a text fallback. Before submitting the Stripe
 * platform application, replace it with the official SVG from
 * https://stripe.com/newsroom/brand-assets (stored at
 * `public/stripe-wordmark.svg`) and swap the <span> for an <Image>. Do not
 * redraw the wordmark ourselves.
 */
export function PoweredByStripe({ className = '' }: { className?: string }) {
  return (
    <a
      href="https://stripe.com"
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 ${className}`}
      aria-label="Powered by Stripe"
    >
      <span>Powered by</span>
      <span className="font-semibold tracking-tight text-slate-500">Stripe</span>
    </a>
  )
}
