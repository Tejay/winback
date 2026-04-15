# 07 — Review pack: data-flow diagram + screenshots

Stripe's Connect review form lets you attach screenshots and a short
"explain your platform" free-text section. A clear data-flow narrative plus
six well-chosen screenshots moves the application from "kicked back with
questions" to "approved on first pass."

**Live reference site for every screenshot below:**
<https://churntool-jxgo.vercel.app>

If the prod site `winbackflow.co` is still pre-launch, capture against the
reference site — the UI is identical and it already demonstrates the flow
end-to-end.

---

## Part A — Data-flow diagram

Drop this into the application form verbatim, and export the mermaid below
as a PNG to attach.

### Narrative (paste into the form)

> Winback is a B2B SaaS that helps subscription merchants recover cancelled
> customers automatically.
>
> 1. **Connect.** A merchant signs up at `winbackflow.co`, completes
>    onboarding, and connects their Stripe account via Stripe Connect OAuth
>    (`read_write` scope).
> 2. **Detect.** We register a Stripe webhook on the merchant's connected
>    account for `customer.subscription.deleted`. The moment a subscriber
>    cancels, Stripe delivers the event to `api/stripe/webhook`.
> 3. **Classify.** We pass the cancellation reason (where provided by the
>    subscriber in Stripe's cancel flow) to an LLM running in zero-retention
>    mode. The LLM returns a category, a tone, and a first-message draft.
> 4. **Send.** We send a single personalised plain-text email via Resend
>    from `reply+<subscriberId>@winbackflow.co` — with the merchant's name on
>    the From line. Replies route back to the merchant's real inbox.
> 5. **Activation.** Every email includes a signed one-click link. Clicking
>    it hits `api/reactivate/<subscriberId>` which — and this is the only
>    place we use Stripe `write` scope — restores the subscription the
>    customer previously held on the merchant's Stripe account.
> 6. **Attribute & bill.** When Stripe confirms the reactivation, we record
>    a `recovery` row with a 12-month attribution window. Our monthly billing
>    cron issues the merchant an invoice on the Winback platform account for
>    15% of each attributed subscriber's monthly revenue.
>
> We never create new subscriptions out of nothing, refund, dispute, or
> change prices. The merchant can disconnect, pause, or delete their
> workspace at any time.

### Mermaid diagram

Save this as `docs/stripe-platform-approval/data-flow.mmd` and render to PNG
with `mmdc` (npx `@mermaid-js/mermaid-cli`) for the submission.

```mermaid
flowchart LR
    subgraph Merchant["Merchant's Stripe account"]
        sub[Subscription] -->|Cancellation| evt[customer.subscription.deleted]
    end

    evt -->|webhook| wb[Winback API<br/>api/stripe/webhook]

    wb -->|classify| llm[LLM<br/>zero-retention mode]
    llm -->|draft| wb

    wb -->|store| db[(Neon Postgres<br/>churned_subscribers)]
    wb -->|send| resend[Resend<br/>reply+id@winbackflow.co]

    resend -->|email| sub_email[Cancelled<br/>subscriber inbox]
    sub_email -->|click activation link| act[api/reactivate]

    act -->|subscription.update| Merchant
    act -->|recovery row + 12mo window| db

    db -->|monthly cron| bill[Winback invoices merchant<br/>15% of attributed revenue]
```

---

## Part B — Screenshot checklist

Use browser dev-tools set to 1440×900, Chrome at default zoom. Export as
full-page PNGs. Store exports alongside this doc at
`docs/stripe-platform-approval/screenshots/`.

| # | Filename | What it shows | Capture URL |
|---|----------|---------------|-------------|
| 1 | `01-landing-hero.png` | Full landing hero with headline, subcopy, pricing strip | `https://churntool-jxgo.vercel.app/` |
| 2 | `02-landing-how-it-works.png` | The three-step Detect / Decide / Act section | `https://churntool-jxgo.vercel.app/#how-it-works` |
| 3 | `03-pricing-page.png` | `/pricing` showing 15% × 12 months, calculator, effective-rate table | `https://churntool-jxgo.vercel.app/pricing` |
| 4 | `04-faq-stripe-section.png` | The "Stripe access & your data" section of `/faq`, expanded on Q1 and Q2 | `https://churntool-jxgo.vercel.app/faq` |
| 5 | `05-onboarding-stripe-connect.png` | The `/onboarding/stripe` page where the merchant initiates Connect — shows the "Powered by Stripe" badge | `https://churntool-jxgo.vercel.app/onboarding/stripe` (signed-in) |
| 6 | `06-stripe-oauth-consent.png` | The live Stripe consent screen after clicking "Connect Stripe" — shows what scopes the merchant approves | Click through the Connect button; screenshot the Stripe-hosted page |
| 7 | `07-settings-integrations.png` | `/settings` showing the connected Stripe row + disconnect button + Danger Zone | `https://churntool-jxgo.vercel.app/settings` |
| 8 | `08-settings-danger-zone.png` | Focus crop of the Danger Zone card (pause + delete) | same as #7, cropped |
| 9 | `09-sample-winback-email.png` | Inbox screenshot of a real Winback email — must show the From line, the `List-Unsubscribe` header (expanded via "show original"), and the visible unsubscribe link in the body | Gmail "Show original" view on a test send |
| 10 | `10-delete-consequence-screen.png` | `/settings/delete` Gate 1 with real numbers rendered | `https://churntool-jxgo.vercel.app/settings/delete` |

Optional bonus:
- `11-subprocessors-page.png` — `/subprocessors`, shows the full list Stripe can audit.
- `12-dpa-page.png` — `/dpa` opening block.

## Part C — What goes in the application form itself

| Form field | Paste this |
|------------|------------|
| Platform name | `Winback` |
| Platform URL | `https://winbackflow.co` |
| Company / entity | Filled from Companies House registration |
| Brief description | First paragraph of the Part A narrative above |
| How will your users use Stripe? | Full Part A narrative |
| Why do you need `read_write`? | Justification block from [02-oauth-app-metadata.md](./02-oauth-app-metadata.md) |
| Refund policy URL | `https://winbackflow.co/refunds` — see [05](./05-refunds-and-cancellations.md) |
| Acceptable use URL | `https://winbackflow.co/aup` — see [06](./06-acceptable-use-policy.md) |
| Support email | `support@winbackflow.co` — see [04](./04-contact-and-support.md) |
| Privacy URL | `https://winbackflow.co/privacy` |
| Terms URL | `https://winbackflow.co/terms` |
| Attachments | Data-flow PNG + screenshots 1–10 from Part B |

## Verification

- [ ] `data-flow.mmd` exists and renders to `data-flow.png`
- [ ] All 10 screenshots captured at 1440×900 and stored under
      `docs/stripe-platform-approval/screenshots/`
- [ ] Each screenshot referenced in Part B is legible and free of test/dev
      banners
- [ ] The Stripe OAuth consent screenshot shows the exact scope list we
      request (`read_write`)
- [ ] The sample win-back email screenshot shows `List-Unsubscribe` header
      and a visible unsubscribe link
- [ ] Part A narrative pastes into the application form without edits
