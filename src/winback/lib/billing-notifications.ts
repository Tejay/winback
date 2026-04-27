import { Resend } from 'resend'
import { resolveFounderNotificationEmail } from './email'

/**
 * Sends the founder a notice that their platform $99/mo charge failed.
 *
 * Stripe's Smart Retries will retry the charge automatically over the
 * next 1–3 weeks. This email is a heads-up so the customer can update
 * their card before retries are exhausted and the subscription becomes
 * `unpaid` (which would pause win-back fee billing too).
 *
 * Best-effort: if RESEND_API_KEY isn't set or there's no notification
 * email on file, the function logs and returns silently. The webhook
 * handler shouldn't fail just because the heads-up didn't go out.
 */
export async function sendPlatformPaymentFailedEmail(params: {
  customerId: string
  invoiceAmountCents: number
  hostedInvoiceUrl: string | null
}): Promise<void> {
  const { customerId, invoiceAmountCents, hostedInvoiceUrl } = params

  const to = await resolveFounderNotificationEmail(customerId)
  if (!to) {
    console.warn('[billing-notifications] no notification email for', customerId)
    return
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[billing-notifications] RESEND_API_KEY not set — skipping email')
    return
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  const amount = `$${(invoiceAmountCents / 100).toFixed(2)}`
  const settingsUrl = `${appUrl}/settings#billing`

  const text = [
    `Your Winback platform payment of ${amount} failed.`,
    '',
    `Stripe will retry the charge automatically over the next few days.`,
    `To avoid an interruption to your card-save and win-back automation,`,
    `please update your payment method:`,
    '',
    `  ${settingsUrl}`,
    '',
    hostedInvoiceUrl ? `Invoice details: ${hostedInvoiceUrl}` : '',
    '',
    `If retries fail, your subscription will be paused and recoveries will`,
    `stop until you update the card.`,
    '',
    `— Winback`,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join('\n')

  try {
    const resend = new Resend(apiKey)
    await resend.emails.send({
      from: 'Winback Billing <noreply@winbackflow.co>',
      to,
      subject: `Action needed: Winback payment failed (${amount})`,
      text,
    })
  } catch (err) {
    console.error('[billing-notifications] failed to send', customerId, err)
  }
}
