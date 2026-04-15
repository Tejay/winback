# Stripe platform approval — submission pack

Everything needed to submit Winback's Stripe Connect platform for approval,
so we can charge connected-account customers (the 15% success fee on recovered
revenue).

## Status at a glance

| # | Item | Status | Doc |
|---|------|--------|-----|
| 1 | Legal entity (Companies House reg + address) | 🔴 Blocked on incorporation | — |
| 2 | Stripe dashboard OAuth metadata | 🟡 Fill in once logo + URLs are final | [02-oauth-app-metadata.md](./02-oauth-app-metadata.md) |
| 3 | "Powered by Stripe" branding on connect surfaces | 🟡 Implement | [03-powered-by-stripe.md](./03-powered-by-stripe.md) |
| 4 | Business / support contact surface | 🟡 Implement | [04-contact-and-support.md](./04-contact-and-support.md) |
| 5 | Refunds & cancellations — dedicated section | 🟡 Implement | [05-refunds-and-cancellations.md](./05-refunds-and-cancellations.md) |
| 6 | Acceptable Use Policy (`/aup`) | 🟡 Implement | [06-acceptable-use-policy.md](./06-acceptable-use-policy.md) |
| 7+8 | Data-flow diagram + review-screenshot pack | 🟡 Capture | [07-review-pack.md](./07-review-pack.md) |

**Reference site for screenshots:** <https://churntool-jxgo.vercel.app>

## How this pack is used

When submitting the platform application at
`https://dashboard.stripe.com/connect/onboarding`:

1. **Application form fields** — 02 covers every URL/name/logo field.
2. **"How will you use Stripe?" free-text box** — copy the data-flow section
   of 07.
3. **"Why do you need write access?"** — paste the justification from the
   `read_write` block in 02.
4. **Screenshot uploads** — use the capture list in 07.
5. **Link the supporting pages** — `/terms`, `/privacy`, `/dpa`,
   `/subprocessors`, `/refunds`, `/aup`, `/contact`. The reviewer clicks these.

## Order of operations

The cheapest path to submission:

1. Incorporate the Ltd, get Companies House number + registered office (blocker).
2. Ship 03–06 in a single PR (all are copy/UI changes, no schema).
3. Capture screenshots per 07 using the live reference site.
4. Fill in the Stripe dashboard fields per 02.
5. Submit.

Typical Stripe turnaround is **3–7 business days**.
