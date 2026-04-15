# 03 — "Powered by Stripe" branding

Stripe's [Connect branding guidelines](https://stripe.com/docs/connect/setting-mcc#branding)
require the "Powered by Stripe" lockup on any surface that initiates a Stripe
flow or communicates that payments are handled by Stripe. Reviewers check this.

## Where it needs to appear

| Surface | File | State today | Action |
|---------|------|-------------|--------|
| Onboarding connect step | `app/onboarding/stripe/page.tsx` | Missing | Add badge under the "Connect Stripe" button. |
| Settings → Integrations → Stripe row | `app/settings/page.tsx` | Missing | Small badge next to the Stripe logo. |
| Landing — `Step 01 — Detect` card | `app/page.tsx` | Missing | Add small "Powered by Stripe" underneath the card where we describe the Stripe connect flow. |

Not required on `/faq`, `/terms`, `/privacy` — those describe Stripe but don't
initiate a flow.

## Implementation

Stripe provides official SVG assets at
<https://stripe.com/newsroom/brand-assets>. Use the "Powered by Stripe" monochrome
variant in slate-500 against the light backgrounds we use.

### Component

```tsx
// components/powered-by-stripe.tsx
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
      {/* Drop in the official Stripe wordmark SVG here */}
      <StripeWordmark className="h-3" />
    </a>
  )
}
```

Store the SVG at `public/stripe-wordmark.svg` (exported from Stripe's brand
assets page — do not redraw).

### Placement examples

- **Onboarding** — under the Connect button:
  ```tsx
  <a href="/api/stripe/connect" className="...">Connect Stripe</a>
  <PoweredByStripe className="mt-3" />
  ```
- **Settings row** — inline with the "Connected" pill:
  ```tsx
  <PoweredByStripe className="ml-2" />
  ```

## Forbidden

- Do not resize or stretch the official wordmark.
- Do not use the Stripe wordmark in a button label — it must be alongside, not
  inside, our CTAs.
- Do not imply Winback is operated by Stripe. We're a platform **using**
  Stripe Connect.

## Verification

- [ ] Badge visible on all three surfaces above
- [ ] Badge links to `https://stripe.com` in new tab
- [ ] SVG not inlined from a screenshot — only the official Stripe-provided
      asset under `public/stripe-wordmark.svg`
- [ ] Screenshot each placement for the review pack (see
      [07-review-pack.md](./07-review-pack.md))
