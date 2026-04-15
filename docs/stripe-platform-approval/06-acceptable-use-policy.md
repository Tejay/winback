# 06 — Acceptable Use Policy (`/aup`)

## Why Stripe cares

Stripe approves Winback as a platform on the assumption that we won't let our
customers weaponise it. Email-abuse platforms ruin Stripe's relationship with
deliverability providers (Google, Microsoft) and draw regulator attention.
Reviewers explicitly ask for an Acceptable Use Policy when the platform
touches end-user communication.

Our existing `/terms` has anti-spam language scattered in Section 5
("Acceptable use"). Pull it into a standalone page so the reviewer can link
to one canonical document.

## Page outline

Route: `/aup` — `app/aup/page.tsx`, same shell as `/terms`.

```markdown
# Acceptable Use Policy.

This policy governs what Winback customers ("you") may and may not do with
the Winback service. Breach of this policy is grounds for immediate account
suspension without refund, and — where legal thresholds are crossed —
reporting to the relevant authorities.

## What Winback is for

Sending a personalised, one-time win-back email from your business's real
identity to a subscriber who cancelled a paid subscription with you on Stripe.
The email must be relevant to the cancelled subscription and must carry your
return-route reply address.

## What you must not do

- **Spam.** Winback sends one email per cancellation. You may not use
  Winback's sending domain to send bulk broadcasts, newsletters, sequences,
  promotions, or any message to subscribers who did not cancel a subscription
  with you through Stripe.
- **Scraped or purchased lists.** The only legitimate input to Winback is a
  Stripe cancellation event you received through your own, consented
  customer relationship. Importing addresses from any other source is a
  terminating breach.
- **Pretending to be someone else.** The "From" name in a win-back email
  must be a real person at your business. You may not impersonate a third
  party, a Stripe employee, or Winback itself.
- **Sending to unsubscribers.** Every Winback email carries `List-Unsubscribe`
  plus a visible link. Unsubscribes are honoured automatically within
  seconds. You may not circumvent, disable, or override this.
- **Illegal, harmful, or hateful content.** The standard prohibitions:
  content that is unlawful, threatens or harasses a person, sexualises
  minors, incites violence, or facilitates fraud, money laundering,
  gambling without a licence, unlicensed financial services, weapons
  trafficking, illegal drugs, CSAM, or terrorism.
- **Regulated industries without compliance.** Healthcare and financial
  services subscriptions may use Winback only if your own compliance
  obligations allow automated email follow-up at the moment of cancellation.
- **Abusing Stripe.** You may not use Winback to automate refunds, create
  subscriptions without the subscriber's click-through, bypass Stripe's own
  terms, or disguise the origin of a charge.
- **Sharing credentials.** Your Stripe OAuth connection, Winback login, and
  API tokens are personal to your business. You may not share them.

## Spam-complaint thresholds

We monitor complaint rate on our sending domain. If complaints from a single
Winback customer exceed **0.3% of messages sent** over a rolling 7-day
window, we automatically pause sending for that customer and email the
founder. Repeat breaches end in termination.

## Reporting abuse

If you believe Winback is being used against you or against a subscriber —
including as a recipient of a Winback email that looks like spam — email
`abuse@winbackflow.co`. We triage within 1 business day.

## Enforcement

Breach of this policy is grounds to:

1. Pause your Winback account immediately
2. Terminate your Winback account with no refund for the current billing
   period
3. Report to the ICO (UK), relevant DPA (EU), Stripe, or law enforcement
   where required

We will tell you why we took action, unless legally prevented from doing so.

## Changes

We update this policy as abuse vectors change. Material changes are emailed
to account owners 14 days before they take effect, except for changes that
address an active abuse incident — those take effect immediately.

— Winback Ltd, {DATE}
```

## Wiring

- Add `/aup` to landing + pricing + `/terms` + `/privacy` + `/dpa` +
  `/refunds` + `/faq` footers.
- Reference `/aup` from `/terms` Section 5 ("Acceptable use") with a line
  `Full policy: [/aup](/aup)`.
- Add one new `/faq` entry under "Reliability & control":
  > **What happens if a Winback customer misuses the product?**
  > We publish an [Acceptable Use Policy](/aup). Breach is grounds for
  > immediate suspension. We monitor spam complaints on our sending domain
  > automatically.
- Add an `abuse@winbackflow.co` alias — route to the same inbox as
  `support@` and `privacy@` until volume justifies splitting.

## Verification

- [ ] `/aup` renders in the same shell as the other legal pages
- [ ] Every legal-page footer includes `/aup`
- [ ] `abuse@winbackflow.co` mailbox reachable
- [ ] Stripe application form → "Acceptable use policy URL" uses
      `https://winbackflow.co/aup`
