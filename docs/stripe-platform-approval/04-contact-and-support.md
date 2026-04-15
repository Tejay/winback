# 04 — Business & support contact surface

Stripe requires a reachable support channel and, for UK entities, a registered
postal address. `privacy@winbackflow.co` covers legal/data-protection but
doesn't read as a "support" channel to reviewers.

## What to add

### 1. New `support@winbackflow.co` mailbox

- Configure in the DNS/Google Workspace account that already routes
  `privacy@`.
- Forward to the founder inbox in the short term — same handling as `privacy@`
  but a distinct address so the review form, footer, and OAuth metadata all
  have a "support" label rather than "privacy."

### 2. Footer — add a contact block

Today the landing + pricing footers show only nav links. Add a left-aligned
three-line block:

```
Winback Ltd  ·  Company no. {TO_FILL}
{Registered office address, 1 line}
support@winbackflow.co
```

Files to touch:
- `app/page.tsx` — landing footer (~L317)
- `app/pricing/page.tsx` — footer (~L119)

Leave the existing nav on the right; this block goes on the left beside the
copyright.

### 3. `/contact` page

Minimal page, same visual shell as `/faq`:

- Heading: **Contact.**
- Three blocks:
  - **Support** — `support@winbackflow.co`. Reply time: 1 business day.
  - **Privacy & GDPR requests** — `privacy@winbackflow.co`. Reply within 30
    days per Article 12.
  - **Security** — `security@winbackflow.co` (same mailbox as privacy for
    now). Responsible-disclosure policy: 90-day window, we won't threaten
    researchers.
- Registered office address block at the bottom.

Link `/contact` from:
- Footer nav (both `app/page.tsx` and `app/pricing/page.tsx`)
- `/faq` bottom line ("If you don't see your question…")

### 4. Update pages that currently point to `privacy@` for support

- `app/faq/page.tsx` — "Email us" links at top + bottom → change to
  `support@winbackflow.co` where the context is "a general question." Keep
  `privacy@` for the GDPR deletion question.
- `app/settings/page.tsx` — no support link today; consider adding a "Need
  help? support@winbackflow.co" footer line under the Danger Zone.

## Registered office — must be real

Stripe verifies against Companies House. A virtual office address is fine for
a UK Ltd (e.g., 1st Formations, Hoxton Mix) provided Companies House has it
as the registered office. Once incorporated, this address goes into:

- `app/terms/page.tsx` (entity block)
- `app/privacy/page.tsx` (data controller block)
- `app/dpa/page.tsx` (processor block)
- Footer (landing + pricing)
- `/contact` page
- Stripe dashboard "Business details"

## Verification

- [ ] `support@` mailbox live, responds within 24h during weekdays
- [ ] `/contact` page renders at /contact with all three contact blocks
- [ ] Footer on `/` and `/pricing` shows entity + address + support email
- [ ] `/faq` links updated (support vs privacy distinction)
- [ ] Companies House number + address appear on terms/privacy/DPA
