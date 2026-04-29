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
            <p style="margin:0 0 8px 0;font-size:14px;line-height:1.6;color:#475569;">
              If you have any questions, just reply to this email.
            </p>
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
