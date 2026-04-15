# 02 — Stripe dashboard OAuth app metadata

Reviewers see the OAuth consent screen that our customers see when they click
"Connect Stripe" in `/onboarding/stripe`. Everything on that screen is
configured in the Stripe dashboard, not in our code.

## Where to set these

Stripe Dashboard → **Connect** → **Settings** → **Platform settings** (test mode
first, then repeat in live once approved).

## Fields to fill in

| Field | Value | Notes |
|-------|-------|-------|
| **Platform name** | `Winback` | Shows as "Winback would like to…" on the consent screen. |
| **Platform website** | `https://winbackflow.co` | Must be a real, reachable marketing site. Stripe clicks it. |
| **Support email** | `support@winbackflow.co` | Real mailbox — see [04-contact-and-support.md](./04-contact-and-support.md). |
| **Privacy policy URL** | `https://winbackflow.co/privacy` | Already live. |
| **Terms of service URL** | `https://winbackflow.co/terms` | Already live. |
| **Logo (app icon)** | 512×512 PNG, transparent background | Lightning-bolt in a blue rounded square, matching `components/logo.tsx`. Export from Figma/SVG. |
| **Brand colour** | `#0f172a` (slate-900) | Matches our primary button. |
| **Business type** | B2B SaaS | |
| **MCC** | `7372` (Computer Software) | |

## Redirect URIs (test + live)

Add both — Stripe will reject the OAuth handshake otherwise.

- Production: `https://winbackflow.co/api/stripe/callback`
- Preview (wildcard not allowed — add explicitly per preview branch if needed):
  `https://winback-git-<branch>-<team>.vercel.app/api/stripe/callback`
- Local dev: `https://<your-ngrok>.ngrok.io/api/stripe/callback`

The code reads `NEXT_PUBLIC_APP_URL` to build the redirect URI — see
`app/api/stripe/connect/route.ts:36`.

## "Why do you need `read_write` scope?" — paste this in

> We read customer, subscription, and cancellation event data from our
> customers' connected Stripe accounts — this is how Winback detects churn
> within 60 seconds and attributes recovered subscribers back to our customer's
> account.
>
> We use write access for exactly **one** purpose: when a cancelled subscriber
> clicks an activation link inside a Winback email, we reactivate the
> subscription they previously held on behalf of the merchant — a one-click
> recovery experience with no re-entry of card details. This is the entire
> value proposition of the platform.
>
> We never:
> - Create new subscriptions or charges out of nowhere
> - Refund or modify existing charges
> - Change prices, products, or plan configurations
> - Write to `Customer` or `PaymentMethod` objects
>
> The merchant can disconnect Winback at any time from their Stripe Dashboard
> → Apps tab, from our Settings page, or by deleting their Winback workspace
> (which triggers an OAuth deauthorize).
>
> We document this scope publicly at <https://winbackflow.co/faq> and in
> inline comments at `app/api/stripe/connect/route.ts`.

## Verification checklist

- [ ] Logo uploaded at 512×512 in test mode
- [ ] All URLs reachable (open each in incognito)
- [ ] Consent screen screenshot captured for the review pack
      (see [07-review-pack.md](./07-review-pack.md))
- [ ] Redirect URIs added for prod + preview + local
- [ ] `support@winbackflow.co` mailbox actually monitored before submitting
