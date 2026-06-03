/**
 * Spec 37 — Inline-CSS, table-based HTML for dunning emails.
 *
 * Plain text version is kept as the structural fallback in email.ts.
 * Resend sends both — recipients see whichever their client prefers.
 *
 * The HTML targets the lowest-common-denominator email-client renderer:
 *   - Tables instead of flex/grid (Outlook 2019 still uses Word's HTML engine)
 *   - Inline `style=""` attrs (Gmail/Yahoo strip <style> blocks)
 *   - Web-safe fonts only ("Helvetica Neue", Arial, sans-serif)
 *   - 600px max-width body table (standard transactional email width)
 *   - Single CTA button via padded <a> (cross-client safe; <button> is not)
 *
 * No new deps — raw HTML string assembly. All user-supplied strings
 * pass through escapeHtml() to prevent XSS via name / planName fields.
 */

const ESCAPE_MAP: Record<string, string> = {
  '&':  '&amp;',
  '<':  '&lt;',
  '>':  '&gt;',
  '"':  '&quot;',
  "'":  '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ESCAPE_MAP[c])
}

/**
 * Subset of DeclineCopy we need to render. Imported as a structural
 * shape rather than the full type to keep email-html.ts decoupled from
 * the decline-codes module — callers pass it in.
 */
export interface DunningDeclineCopy {
  reason:               string
  action:               string
  suppressUpdateCta?:   boolean
}

export interface DunningHtmlInputs {
  customerName:  string | null
  planName:      string
  amount:        string          // already formatted, e.g. "49.00"
  currency:      string          // already lowercased, e.g. "usd"
  retryDateStr:  string | null   // e.g. "2 May" — null when there's no further retry
  updateLink:    string
  unsubLink:     string
  fromName:      string
  isFinalRetry?: boolean         // T3 path, OR no-retry T1 path
  declineCopy?:  DunningDeclineCopy  // Spec 34 — bespoke reason/action lines
}

export function renderDunningEmailHtml(i: DunningHtmlInputs): string {
  const greeting = `Hi ${escapeHtml(i.customerName ?? 'there')},`
  const planLine = `${escapeHtml(i.planName)} (${escapeHtml(i.amount)} ${escapeHtml(i.currency.toUpperCase())})`

  // Three retry-line variants, independent of tone:
  //   1. No future retry (retryDateStr null)        → Stripe gave up. Last call.
  //   2. Final retry IS coming (isFinalRetry true)  → T3 path: one-shot urgency.
  //   3. Otherwise (T1 / T2)                        → "we'll try again on X".
  const retryLine = !i.retryDateStr
    ? `This was our last automatic attempt. To keep your subscription active, please update your payment method below.`
    : i.isFinalRetry
    ? `We'll try your card one final time on <strong>${escapeHtml(i.retryDateStr)}</strong>. If it fails, your subscription will be cancelled.`
    : `We'll try your card again on <strong>${escapeHtml(i.retryDateStr)}</strong> — updating before then means no interruption to your service.`

  const tone = i.isFinalRetry ? 'Final reminder' : 'Heads up'

  // Spec 34 — bespoke decline copy. When provided, swap the generic
  // "We tried to charge…" intro for focused "Why this happened" +
  // "Best next step" lines. suppressUpdateCta hides the dark CTA
  // button (used for `temporary` / Stripe-side declines).
  const introBlock = i.declineCopy
    ? `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">
              We tried to charge your card for ${planLine} but it didn&#39;t go through.
            </p>
            <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;color:#0f172a;">Why this happened</p>
            <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">
              ${escapeHtml(i.declineCopy.reason)}
            </p>
            <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;color:#0f172a;">Best next step</p>
            <p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">
              ${escapeHtml(i.declineCopy.action)}
            </p>`
    : `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">
              We tried to charge your card for ${planLine} but it didn&#39;t go through.
            </p>`

  const buttonBlock = i.declineCopy?.suppressUpdateCta
    ? ''
    : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
              <tr><td style="background:#0f172a;border-radius:9999px;">
                <a href="${escapeHtml(i.updateLink)}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">Update payment</a>
              </td></tr>
            </table>`

  return `
<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;max-width:600px;">
          <tr><td style="padding:32px 40px;">
            <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#3b82f6;">${escapeHtml(tone)}</p>
            <p style="margin:0 0 24px 0;font-size:16px;line-height:1.5;color:#0f172a;">${greeting}</p>
            ${introBlock}
            <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#475569;">
              ${retryLine}
            </p>
            ${buttonBlock}
            <p style="margin:0;font-size:14px;line-height:1.6;color:#475569;">
              — ${escapeHtml(i.fromName)}
            </p>
          </td></tr>
          <tr><td style="border-top:1px solid #e2e8f0;padding:16px 40px;">
            <p style="margin:0;font-size:11px;line-height:1.5;color:#94a3b8;">
              Don&#39;t want these reminders?
              <a href="${escapeHtml(i.unsubLink)}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a>.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim()
}

// ============================================================================
// Shared building blocks for non-dunning emails (added later — dunning
// has its own bespoke renderer above and is left untouched).
//
// Design goals (consistent with renderDunningEmailHtml):
//   - Single dark CTA button (`<a>` styled as button — cross-client safe)
//   - Small 11px grey unsubscribe / footer line, separated by a hairline
//   - 600px max-width card on a light grey backdrop
//   - All variables HTML-escaped at the edge
// ============================================================================

interface CtaInput {
  label: string
  url:   string
}

interface FooterLinkInput {
  label: string
  url:   string
}

interface EmailLayoutInputs {
  /**
   * Small uppercase eyebrow at the top (e.g. "Heads up", "Verify your
   * email"). Optional — omitting renders nothing.
   */
  tone?:           string
  /**
   * Plain-text body. May contain blank lines (`\n\n`) which become
   * paragraph breaks. Each paragraph is HTML-escaped — do NOT pass
   * HTML here.
   */
  body:            string
  /**
   * Optional CTA button below the body. Renders as a dark pill anchor.
   */
  cta?:            CtaInput
  /**
   * Optional small grey footer line. Used for unsubscribe ("Don't want
   * these? Unsubscribe."), or any de-emphasised tertiary action.
   */
  footer?: {
    text:  string
    link?: FooterLinkInput
  }
}

/**
 * Render a body paragraph block from plain text. Blank-line-separated
 * paragraphs become `<p>` elements; single line breaks within a
 * paragraph become `<br>`. Output is HTML-escaped.
 */
function renderBodyParagraphs(body: string): string {
  const paragraphs = body.trim().split(/\n\s*\n/)
  return paragraphs
    .map(p => {
      const escaped = escapeHtml(p.trim()).replace(/\n/g, '<br>')
      return `<p style="margin:0 0 16px 0;font-size:14px;line-height:1.6;color:#475569;">${escaped}</p>`
    })
    .join('\n            ')
}

/**
 * Render a single dark pill CTA button. Padded `<a>` (cross-client safe;
 * `<button>` is not).
 */
function renderCtaButton(cta: CtaInput): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
              <tr><td style="background:#0f172a;border-radius:9999px;">
                <a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:12px 28px;font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">${escapeHtml(cta.label)}</a>
              </td></tr>
            </table>`
}

/**
 * Generic email shell. Used by every non-dunning renderer below.
 *
 * Card layout, dark CTA button (optional), tiny grey footer (optional).
 * Body paragraphs are HTML-escaped.
 */
function renderEmailShell(i: EmailLayoutInputs): string {
  const toneBlock = i.tone
    ? `<p style="margin:0 0 8px 0;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#3b82f6;">${escapeHtml(i.tone)}</p>`
    : ''
  const ctaBlock = i.cta ? renderCtaButton(i.cta) : ''
  const footerBlock = i.footer
    ? `<tr><td style="border-top:1px solid #e2e8f0;padding:16px 40px;">
            <p style="margin:0;font-size:11px;line-height:1.5;color:#94a3b8;">
              ${escapeHtml(i.footer.text)}${i.footer.link ? ` <a href="${escapeHtml(i.footer.link.url)}" style="color:#94a3b8;text-decoration:underline;">${escapeHtml(i.footer.link.label)}</a>.` : ''}
            </p>
          </td></tr>`
    : ''
  return `
<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:32px 0;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;max-width:600px;">
          <tr><td style="padding:32px 40px;">
            ${toneBlock}
            ${renderBodyParagraphs(i.body)}
            ${ctaBlock}
          </td></tr>
          ${footerBlock}
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim()
}

// ============================================================================
// Per-email-type renderers — thin adapters that decide tone, CTA label,
// and footer presence for each kind of email.
// ============================================================================

/**
 * Win-back emails (Tier 1/2 exit + follow-up + improvement-match +
 * promotion + Tier 3 silent-churn). Goes to subscribers — gets a
 * Resubscribe button and a small unsubscribe footer.
 *
 * `body` is the LLM-generated (or hardcoded for Tier 3) text body
 * complete with greeting and signature — we render it verbatim and
 * add the Resubscribe button + unsubscribe footer around it.
 */
export function renderWinbackEmailHtml(i: {
  body:             string
  reactivationUrl:  string
  unsubscribeUrl:   string
}): string {
  return renderEmailShell({
    body: i.body,
    cta:  { label: 'Resubscribe', url: i.reactivationUrl },
    footer: {
      text: "Don't want these emails?",
      link: { label: 'Unsubscribe', url: i.unsubscribeUrl },
    },
  })
}

/**
 * Personal exit email (Tier 1/2 listen-and-learn first touch).
 *
 * The exit email's job is to get a REPLY, not a click. The marketing
 * shell above (card + blue eyebrow + dark Resubscribe button) reads as
 * an automated sequence and suppresses replies. This renderer strips
 * all of that: no card chrome, no eyebrow, no CTA button — just the
 * founder's note on a plain white background, ending in the question
 * the copy already asked.
 *
 * Layout (top → bottom):
 *   - body verbatim (greeting → 2-sentence question → sign-off)
 *   - reply cue: "↩ Just hit reply — comes straight to me…"
 *   - "Changed your mind? Resubscribe" link, close to the text (the
 *     low-pressure path for the minority ready to return)
 *   - hairline, then "Don't want these emails? Unsubscribe." at the
 *     very bottom — kept identical to the original email's opt-out, so
 *     a visible opt-out is always present (we don't rely on Gmail's
 *     native header chip).
 *
 * A ~560px max-width wrapper keeps it from sprawling full-width on
 * desktop, but there is deliberately no border / background card.
 */
export function renderPersonalExitEmailHtml(i: {
  body:            string
  reactivationUrl: string
  unsubscribeUrl:  string
}): string {
  const bodyParas = renderBodyParagraphs(i.body)
  return `
<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body style="margin:0;padding:0;background:#ffffff;font-family:'Helvetica Neue',Arial,sans-serif;color:#202124;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;padding:24px 0;">
      <tr><td align="left">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
          <tr><td style="padding:8px 24px 0;">
            ${bodyParas}
            <p style="margin:18px 0 4px;font-size:13px;line-height:1.6;color:#5f6368;">
              ↩ Just hit reply — comes straight to me, I read every one.
            </p>
            <p style="margin:4px 0 0;font-size:13px;line-height:1.6;color:#5f6368;">
              Changed your mind? <a href="${escapeHtml(i.reactivationUrl)}" style="color:#5f6368;text-decoration:underline;">Resubscribe</a>
            </p>
            <p style="margin:48px 0 0;padding-top:14px;border-top:1px solid #e8eaed;font-size:12px;line-height:1.6;color:#94a3b8;">
              Don&#39;t want these emails? <a href="${escapeHtml(i.unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">Unsubscribe</a>.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim()
}

/**
 * Password reset — single dark "Reset password" button, no unsub
 * footer (transactional/account-recovery; same precedent as the
 * text-only version in email.ts:sendPasswordResetEmail).
 */
export function renderPasswordResetHtml(i: { resetUrl: string }): string {
  return renderEmailShell({
    tone: 'Reset your password',
    body: `Someone requested a password reset for this Winback account.

If it was you, click the button below to set a new password.

This link expires in 24 hours and can only be used once. If you've requested multiple reset emails, only the most recent link will work.

If you didn't request this, you can ignore this email — your password won't change.`,
    cta:  { label: 'Reset password', url: i.resetUrl },
  })
}

/**
 * Email verification — single "Verify email" button, no unsub footer
 * (transactional/account-lifecycle).
 */
export function renderVerificationEmailHtml(i: {
  founderName: string | null
  verifyUrl:   string
}): string {
  const greeting = i.founderName ? `Hi ${i.founderName},` : 'Hi there,'
  return renderEmailShell({
    tone: 'Confirm your email',
    body: `${greeting}

Welcome to Winback. Click the button below to confirm your email and finish creating your account.

This link expires in 7 days. If you didn't sign up for Winback, you can safely ignore this email.

— Winback`,
    cta:  { label: 'Confirm email', url: i.verifyUrl },
  })
}

/**
 * Day-3 onboarding nudge — founder signed up but hasn't connected
 * Stripe. Single "Connect Stripe" button. Transactional/relationship
 * (no unsubscribe by design; precedent: sendOnboardingNudgeEmail).
 */
export function renderOnboardingNudgeHtml(i: {
  founderName: string | null
  connectUrl:  string
}): string {
  const greeting = i.founderName ? `Hi ${i.founderName},` : 'Hi there,'
  return renderEmailShell({
    tone: 'Still want to set up Winback?',
    body: `${greeting}

You signed up a few days ago but haven't connected Stripe yet — that's the only step left. Takes about 90 seconds.

If something's blocking you — Stripe permissions, a question about how it works, anything else — just hit reply and tell us. We'd genuinely like to know what's in the way.

If it's not the right fit, ignore this — we'll clean up the unused account in 90 days.

— Winback`,
    cta:  { label: 'Connect Stripe', url: i.connectUrl },
  })
}

/**
 * Day-83 dormant-account deletion warning — courtesy notice 7 days
 * before the cron auto-prunes. Single "Connect Stripe" button.
 * Transactional/functional (no unsubscribe).
 */
export function renderDormantWarningHtml(i: {
  founderName: string | null
  connectUrl:  string
}): string {
  const greeting = i.founderName ? `Hi ${i.founderName},` : 'Hi there,'
  return renderEmailShell({
    tone: 'Account closing in 7 days',
    body: `${greeting}

You signed up ~12 weeks ago but never connected Stripe. We'll delete the unused account in 7 days.

To keep it, connect Stripe (~90 seconds).

If you'd rather we delete it, ignore this — no further messages. Questions? Hit reply.

— Winback`,
    cta:  { label: 'Connect Stripe', url: i.connectUrl },
  })
}

/**
 * Pilot ending soon — informational heads-up before normal billing
 * kicks in. No CTA button (no action required), no unsubscribe (the
 * recipient is the merchant, who is in an active commercial
 * relationship). Just clean HTML wrapper for visual consistency.
 */
export function renderPilotEndingHtml(i: {
  founderName: string | null
  dateStr:     string
}): string {
  const greeting = i.founderName ? `Hi ${i.founderName},` : 'Hi there,'
  return renderEmailShell({
    tone: 'Your pilot ends soon',
    body: `${greeting}

Quick heads-up: your WinbackFlow pilot ends on ${i.dateStr}. After that, normal billing kicks in — a single flat monthly fee priced by your own MRR (Starter $99, Growth $299, Scale $699; Enterprise is sales-handled). No per-recovery charges, unlimited recovery volume on every tier.

Nothing for you to do right now. The first delivered recovery after the pilot ends will prompt you in-app to confirm your tier and subscribe — we'll show you the math (your computed MRR, the resulting tier, the fee) before any charge.

If you want to discuss pricing or extend the pilot, just hit reply.

Thanks for kicking the tires.

— WinbackFlow`,
  })
}

/**
 * Founder handoff — internal email TO the founder when the AI decides
 * a subscriber is better served by a personal reply. The mailto link
 * IS the action (opens the founder's email client pre-populated).
 *
 * `body` is the pre-built rich-text body from buildHandoffNotification()
 * which already contains the subscriber context + conversation history.
 * We surface the mailto link as a "Reply to {name}" button and add a
 * smaller "View dashboard" footer link. No unsubscribe (internal email).
 */
export function renderFounderHandoffHtml(i: {
  body:         string
  mailtoUrl?:   string
  mailtoLabel?: string
  dashboardUrl: string
}): string {
  // The plain-text body uses box-drawing dividers (──────) as section
  // separators — appropriate in monospace, ugly in HTML. Strip those
  // lines; the paragraph breaks they delimited still give visual
  // separation via the email shell's <p> margin-bottom.
  // Also strip the "→ REPLY TO <name>: mailto:..." and "→ View full
  // details: ..." lines — those URLs become the CTA button and the
  // dashboard footer link respectively, so the inline raw versions
  // become redundant noise in HTML.
  const cleanedBody = i.body
    .split('\n')
    .filter(line => !/^[─━]+\s*$/.test(line))
    .filter(line => !/^→ REPLY TO /.test(line))
    .filter(line => !/^→ View full details:/.test(line))
    .filter(line => !/^\s*\(opens your email client/.test(line))
    .filter(line => !/^\s*their reactivation link included\)/.test(line))
    .filter(line => !/^\s*\(subscriber has no email/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')  // collapse runs of blank lines from the strip
    .trim()
  return renderEmailShell({
    body: cleanedBody,
    cta:  i.mailtoUrl ? { label: i.mailtoLabel ?? 'Reply', url: i.mailtoUrl } : undefined,
    footer: { text: 'Full subscriber details:', link: { label: 'Open dashboard', url: i.dashboardUrl } },
  })
}

