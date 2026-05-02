# Spec 44 — Pricing page attribution disclosure parity

**Phase:** Public-facing copy parity (follow-up to Spec 42)
**Depends on:** Spec 42 (FAQ + refunds attribution-disclosure fix)
**Estimated time:** ~15 min, copy-only

---

## Context

Spec 42 fixed `/faq` and `/refunds` to enumerate the four billing
triggers for the 1× MRR performance fee (click, reply, founder
handoff, AI pause) instead of the misleading single-trigger
"clicked our reactivate link" claim.

`/pricing` was flagged as out-of-scope in Spec 42 and has not yet
been audited. Audit result: `/pricing` doesn't *lie* like the old
FAQ did — it punts to "our attribution window" — but that's
weasel-vague and raises more questions than it answers. Prospects
on `/pricing` are top-of-funnel, deciding whether Winback is worth
their time. Vagueness on what triggers the fee leaks trust at
exactly the moment we're earning it.

This is a small copy parity pass — bring `/pricing`'s "What counts
as a win-back?" answer into shape with `/faq`'s.

## Goals

- Replace `/pricing`'s vague "attribution window" framing with the
  same four-trigger enumeration shipped in Spec 42 on `/faq`.
- Match tone — `/pricing` is more concise than `/faq` so the
  bullets should be tighter; no need to repeat full-sentence
  explainers.
- Keep `/pricing`'s dl/dt/dd structure unchanged (just the dd
  content swaps).

## Non-goals

- **Restructuring `/pricing`** beyond the one Q&A edit. Other
  questions on the page are accurate as-is.
- **Adding the new "If I personally write back…" Q** to `/pricing`.
  That's a deeper-funnel question better served by the FAQ link
  already on `/pricing`.
- **In-product disclosure**, customer notice (Spec 42's edge case
  #2 — moot, no live customers).

## What changes

### Replace the "What counts as a win-back?" answer

Current ([app/pricing/page.tsx:42-49](app/pricing/page.tsx:42)):

> A subscriber who actively cancelled and then reactivated their
> subscription within our attribution window. Payment recoveries
> are not win-backs — those are covered by the platform fee (up
> to 500/month).

Proposed (matches `/faq`'s shape, tighter for top-of-funnel):

> A cancelled subscriber comes back after we engaged with them.
> Specifically, one of:
>
> - They clicked our reactivate link.
> - They replied to our email.
> - They came back within 30 days of us escalating to you (a "handoff").
> - They came back within 30 days of you pausing our AI for them.
>
> Payment recoveries aren't win-backs — those are covered by the
> $99/mo platform fee (up to 500/month).

## Critical files

| Path | Change |
|---|---|
| `specs/44-pricing-page-attribution-parity.md` | **new** (this file) |
| `app/pricing/page.tsx` | One `dd` content swap (the "What counts as a win-back?" answer). |

No other files. No tests. No schema. No env vars.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] Manual click-through on `/pricing` — answer enumerates four
      triggers
- [ ] Visual check: bullets render correctly inside the existing
      `dl/dt/dd` shape (may need a small `<ul>` styling pass if
      the dd doesn't accept lists cleanly — unlikely since the
      surrounding page is plain-prose Tailwind)
- [ ] Cross-check against [app/api/stripe/webhook/route.ts:392-435](app/api/stripe/webhook/route.ts:392)
      — the four triggers in the copy match the four `'strong'`
      attribution branches in code

## Out of scope

- Other surfaces (`/landing`, in-product, marketing emails) — no
  audit done; flag in a follow-up if/when they're touched
- Visual redesign of `/pricing`
- A/B testing the four-trigger language vs the old "attribution
  window" framing
