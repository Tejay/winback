/**
 * Admin alert sender — Resend-direct, bypasses the subscriber-scoped
 * checks in src/winback/lib/email.ts (DNC / AI pause / etc.).
 *
 * Used only by the red-light email cron. Keep the surface tiny:
 * subject + plain-text body. No HTML rendering, no signoff, no
 * unsubscribe footer — these go to an internal ops inbox.
 *
 * Env vars:
 *   RESEND_API_KEY    — required (already used elsewhere in the app)
 *   ADMIN_ALERT_EMAIL — recipient; defaults to errors@winbackflow.co
 *   ADMIN_ALERT_FROM  — From: address; defaults to alerts@winbackflow.co
 *
 * Returns { ok: true, messageId } on success or { ok: false, error } if
 * configuration or the API call fails. Never throws — callers (the cron)
 * already log and persist their own outcome.
 */
import { Resend } from 'resend'

export interface AdminAlertResult {
  ok: boolean
  messageId?: string
  error?: string
}

const DEFAULT_TO   = 'errors@winbackflow.co'
const DEFAULT_FROM = 'Winback Alerts <alerts@winbackflow.co>'

export async function sendAdminAlert(params: {
  subject: string
  body: string
}): Promise<AdminAlertResult> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return { ok: false, error: 'RESEND_API_KEY not configured' }
  }

  const to   = process.env.ADMIN_ALERT_EMAIL ?? DEFAULT_TO
  const from = process.env.ADMIN_ALERT_FROM  ?? DEFAULT_FROM

  try {
    const resend = new Resend(apiKey)
    const res = await resend.emails.send({
      from,
      to,
      subject: params.subject,
      text: params.body,
    })
    if (res.error) {
      return { ok: false, error: `Resend: ${res.error.name} ${res.error.message ?? ''}`.trim() }
    }
    return { ok: true, messageId: res.data?.id }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
