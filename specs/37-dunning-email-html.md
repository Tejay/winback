# Spec 37 — HTML dunning emails: button CTA + de-emphasized unsubscribe

**Phase:** Pre-launch hardening
**Depends on:** Spec 28 (idempotent email send), Spec 33 (multi-touch
dunning T2/T3 — same email functions), Spec 35 (Stripe Checkout
update-payment URL — what the button links to)
**Estimated time:** ~half a day

---

## Context

The dunning emails today (T1, T2, T3 — Specs 09 + 33) ship as **plain
text only**. Resend renders the URL inline:

```
You can update your payment method here:
https://tejay.ngrok.app/api/update-payment/38a705a6-3290-44e9-9971-…

We'll try again on 2 May — updating before then means no interruption.

— Thejas

— — —
If you'd rather not hear from us, unsubscribe: https://tejay.ngrok.app/api/unsubscribe/…
```

Two UX problems caught during Spec 35 click-testing:

1. **The update-payment URL is a long ugly raw string.** It's the most
   important action in the email, and it looks like a tracker URL.
   Conversion suffers because the customer's eye glosses over it.
   Comparable transactional emails (Stripe's own, Notion, Linear, etc.)
   ship a styled "Update payment" button.
2. **Unsubscribe is rendered at the same visual weight as the rest of
   the body.** It should be a small grey footer line, not a peer of
   the call to action. Plain text gives us no way to de-emphasize it.

Both are fixed by sending an HTML body alongside the text body. Resend
supports `{ html, text }` on the same `emails.send()` call — most
clients render the HTML; clients that prefer plain text (Apple Mail's
"Show plain text", text-only command-line clients, accessibility
readers) get the existing text version unchanged.

This spec makes T1 / T2 / T3 dunning emails ship as proper transactional
HTML with a styled button and a small grey unsubscribe footer.

## User-approved decisions

1. **Dunning emails only.** T1 (`sendDunningEmail`), T2 + T3
   (`sendDunningFollowupEmail`). Other email types (exit, win-back,
   onboarding follow-up, password reset, verification) are **not** in
   scope. They'll get the same treatment in a follow-up spec once the
   pattern is proven.
2. **Raw HTML strings with inline CSS.** No new dep (no react-email,
   no MJML). Inline styles only — `<style>` blocks get stripped by
   most webmail clients. Table-based layout for Outlook compat.
3. **Both `html` and `text` are sent.** Resend forwards both;
   recipients see whichever their client prefers. No degradation for
   plain-text users.
4. **No merchant theming in v1.** Button is the same neutral dark
   `#0f172a` (matching CLAUDE.md design tokens) for every merchant.
   v2 (post-pilot) can pull `account.settings.branding.primary_color`
   from Stripe and apply per-merchant accent — same hook as Spec 36 v2.
5. **HTML escapes everything user-supplied.** Customer name, plan
   name, founder name. Tiny `escapeHtml()` helper, no template engine.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Customer's eye lands on the call-to-action immediately | Big dark "Update payment" button, top-of-fold, replaces the inline URL |
| 2 | Unsubscribe is visible but not competing for attention | Small grey footer link below a subtle divider |
| 3 | Plain-text fallback unchanged | Existing text body still passed to Resend; Spec 33's text content is the canonical fallback |
| 4 | Cross-client rendering doesn't break | Table-based layout, inline CSS, no `<style>`/`<link>` tags, no web fonts; tested against Gmail, Outlook, Apple Mail by inspection |
| 5 | No XSS via customer-supplied fields | All interpolated strings (name, plan, founder) pass through `escapeHtml()` |

---

## Non-goals

- **HTML for non-dunning emails** (exit, win-back, onboarding follow-up,
  password reset, verification). Same pattern, separate spec.
- **Per-merchant theming** (logo image, primary color). v2.
- **Email-click tracking pixels.** Privacy-leaning + Resend's
  built-in delivery telemetry already covers what we need.
- **A/B testing different button copy / colors.** Premature; pilot
  scale is too small to A/B meaningfully.
- **Localised copy.** English only.
- **Decline-code-aware copy** in the body. Spec 34 layers that on top
  of whichever rendering we have. The "Why this happened" line will
  drop into the same template once Spec 34 ships — this spec leaves
  the structure ready for it.

---

## Detection

Visual + behavioural, no SQL changes.

1. Re-run `scripts/test-spec35-link.ts` (sends a fresh T1 to the test
   inbox)
2. Inspect inbox:
   - "Update payment" appears as a button (dark background, white text,
     padding, rounded corners)
   - Body copy reads cleanly without raw URLs interrupting paragraphs
   - Footer has a divider then small grey "Unsubscribe" link — visibly
     subordinate to the rest of the email
3. View Source / "Show original" — confirm the email has both
   `Content-Type: text/html` and `Content-Type: text/plain` parts
   (Resend wraps them in a multipart/alternative envelope)

---

## Code changes

### 1. New module: `src/winback/lib/email-html.ts`

Pure rendering helpers. No DB calls, no I/O.

```ts
/**
 * Spec 37 — Inline-CSS, table-based HTML for dunning emails.
 * Plain text version is kept as the structural fallback in email.ts.
 *
 * The HTML targets the lowest-common-denominator email-client renderer:
 *   - Tables instead of flex/grid (Outlook 2019 still uses Word's HTML engine)
 *   - Inline `style=""` attrs (Gmail/Yahoo/etc. strip <style> blocks)
 *   - Web-safe fonts only ("Helvetica Neue", Arial, sans-serif)
 *   - 600px max-width body table (standard transactional email width)
 *   - Single CTA button via padded <a> (cross-client safe; no <button>)
 */

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ESCAPE_MAP[c])
}

export interface DunningHtmlInputs {
  customerName:  string | null   // "Eve Human-ask" or null → "there"
  planName:      string          // "Premium Monthly"
  amount:        string          // "49.00" — already formatted
  currency:      string          // "usd" / "gbp" — already lowercased
  retryDateStr:  string | null   // "2 May" — null for the final-retry T1 path
  updateLink:    string          // /api/update-payment/<id>
  unsubLink:     string          // /api/unsubscribe/<id>?t=…
  fromName:      string          // founder name / product name
  isFinalRetry?: boolean         // true for T3 + the no-retry T1 branch
}

export function renderDunningEmailHtml(i: DunningHtmlInputs): string {
  const greeting = `Hi ${escapeHtml(i.customerName ?? 'there')},`
  const planLine = `${escapeHtml(i.planName)} (${escapeHtml(i.amount)} ${escapeHtml(i.currency.toUpperCase())})`
  const retryLine = i.retryDateStr
    ? `We'll try your card again on <strong>${escapeHtml(i.retryDateStr)}</strong> — updating before then means no interruption to your service.`
    : `This was our last automatic attempt. To keep your subscription active, please update your payment method below.`
  const tone = i.isFinalRetry ? 'Final reminder' : 'Heads up'

  return `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;max-width:600px;">
          <tr><td style="padding:32px 40px;">
            <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#3b82f6;">${escapeHtml(tone)}</p>
            <p style="margin:0 0 24px 0;font-size:16px;line-height:1.5;color:#0f172a;">${greeting}</p>
            <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">
              We tried to charge your card for ${planLine} but it didn't go through.
            </p>
            <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#475569;">
              ${retryLine}
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
              <tr><td style="background:#0f172a;border-radius:9999px;">
                <a href="${escapeHtml(i.updateLink)}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">Update payment</a>
              </td></tr>
            </table>
            <p style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#475569;">
              If you have any questions, just reply to this email.
            </p>
            <p style="margin:0 0 0 0;font-size:14px;line-height:1.6;color:#475569;">
              — ${escapeHtml(i.fromName)}
            </p>
          </td></tr>
          <tr><td style="border-top:1px solid #e2e8f0;padding:16px 40px;">
            <p style="margin:0;font-size:11px;line-height:1.5;color:#94a3b8;">
              Don't want these reminders?
              <a href="${escapeHtml(i.unsubLink)}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a>.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim()
}
```

### 2. `src/winback/lib/email.ts` — wire in HTML

In `sendDunningEmail`:

```ts
import { renderDunningEmailHtml } from './email-html'

// ... existing setup ...

// Existing text body builds unchanged.
let subject: string
let body: string         // text version (unchanged)
const isFinal = !nextRetryDate

if (nextRetryDate) {
  // ... existing T1 text body ...
} else {
  // ... existing final-retry T1 text body ...
}

const html = renderDunningEmailHtml({
  customerName: customerName,
  planName,
  amount: (amountDue / 100).toFixed(2),
  currency,
  retryDateStr: nextRetryDate
    ? nextRetryDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    : null,
  updateLink,
  unsubLink,
  fromName,
  isFinalRetry: isFinal,
})

const res = await callWithRetry(
  () => resend.emails.send({
    from, to: email,
    subject,
    html,                      // NEW — Spec 37
    text: body,                // unchanged — plain-text fallback
    headers: listUnsubscribeHeaders(subscriberId),
  }),
  { ctx: 'sendDunning' },
)
```

Same shape for `sendDunningFollowupEmail` (T2/T3) — `isFinalRetry`
maps to the existing param.

### 3. `wb_emails_sent.body_text` keeps storing the text body

Spec 27's Inspector renders `body_text` for ops debugging. We don't
need to also store the HTML — text is human-readable in the inspector
panel and the HTML can be regenerated from the same inputs if needed
for reproduction. No schema change.

### 4. No changes to:

- Subject lines
- `wb_emails_sent` shape, idempotency, or types
- The cron / state machine
- The `/api/update-payment/[id]` route or Checkout Session
- The `/welcome-back` page (Spec 36 stays orthogonal)
- Webhook handling
- `headers: listUnsubscribeHeaders(...)` — already provides `List-Unsubscribe` for one-click unsub at the client level (Gmail's "Unsubscribe" link in the header bar)

---

## Tests (~6 new)

`src/winback/__tests__/email-html.test.ts` (new):

- `renderDunningEmailHtml` includes a clickable `<a>` with the exact
  update link as `href`
- The "Update payment" button text appears with dark background style
- Footer contains a small grey unsubscribe `<a>` styled with `color:#94a3b8`
  and `font-size:11px`
- Customer name is HTML-escaped — `<script>alert("x")</script>` in
  `customerName` does NOT appear as raw HTML
- T1 (with retry date) body contains "We'll try your card again on…"
- T3 / final-retry body (`isFinalRetry: true` AND `retryDateStr: null`)
  uses the "last automatic attempt" copy

`src/winback/__tests__/email.test.ts` (extend, ~2):

- `sendDunningEmail` passes both `text` and `html` fields to Resend
- `sendDunningFollowupEmail` does the same when `isFinalRetry: true`

---

## Verification

```bash
git checkout -b feat/spec-37-dunning-email-html
# (after writes)
npx tsc --noEmit
npx vitest run

# End-to-end manual:
# 1. Re-run scripts/test-spec35-link.ts → fresh T1 to the test inbox
# 2. Open email — confirm:
#    - "Heads up" / "Final reminder" colored label at top (Winback blue
#      accent — that's a brand-token *color*, not the Winback wordmark)
#    - "Hi {name}," greeting
#    - "Update payment" button (dark bg, white text, rounded), top-of-fold
#    - Body copy with bold retry date
#    - "— {fromName}" sign-off
#    - Subtle divider, then small grey "Unsubscribe" footer
# 3. View → Show original / View source → confirm:
#    - Content-Type: multipart/alternative
#    - Both text/html and text/plain parts present
# 4. Toggle Apple Mail → View → Plain Text Alternative — confirm the
#    text body is still readable (existing copy, unchanged)
# 5. Open in Gmail mobile (web) and Outlook desktop (or VML preview tool):
#    - Layout doesn't blow out, button still looks like a button, no
#      visible CSS in body text
```

---

## Edge cases handled

1. **Customer name has angle brackets / quotes / ampersands.** All
   user-supplied strings pass through `escapeHtml()`. No XSS, no
   broken DOM.
2. **Customer name is null.** Greeting falls back to "Hi there,"
   (existing behaviour).
3. **Plan name has special characters.** Same `escapeHtml()` path.
4. **Long names overflow the 600px-wide container.** Browser wraps
   on word boundaries; the table layout doesn't break. We don't need
   to truncate.
5. **Resend throws / rate-limits.** Existing `callWithRetry` wrapper
   handles 429s. Spec 37 doesn't change the call site's failure
   semantics.
6. **HTML render returns empty string** (defensive — shouldn't happen).
   Resend would still send the text body; the recipient sees the
   plain-text version. Acceptable degradation.
7. **Outlook 2019 strips border-radius on the button.** It'll render
   as a square dark button — still legible, still clickable, still
   on-brand-ish. Acceptable.
8. **Customer's email client refuses HTML entirely** (some
   accessibility readers, command-line clients). They get the
   plain-text version unchanged. No regression.

---

## Out of scope (future)

- **Spec 38 (planned next):** HTML treatment for the other email
  types — exit, win-back, onboarding follow-up, password reset,
  verification. Same `email-html.ts` module gets new render functions.
- **Per-merchant theming** (logo image, primary color from Stripe).
  Same hook point as Spec 36 v2.
- **Click tracking pixels** / open-rate beacons.
- **A/B testing button copy** ("Update payment" vs "Continue your
  subscription" vs "Fix your payment method").
- **Dark-mode-aware HTML** (`@media (prefers-color-scheme: dark)`).
  Most webmail strips media queries; deferred until pilot data shows
  it matters.
