import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { billingOptOutToken } from '@/src/winback/lib/billing-notifications'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 51 — opt-out endpoint linked from the monthly churn-report email.
 *
 * Click flow: merchant clicks the "Unsubscribe" link in the monthly email
 *  → GET /api/billing/opt-out?customer=<id>&t=<signedToken>
 *  → token verified → billingEmailsOptedOutAt set on the customer row
 *  → all future billing nudges + monthly reports suppressed
 *
 * Dashboard banner is unaffected — they can still resume any time by
 * subscribing, and disconnecting Stripe is always available via /settings.
 *
 * Idempotent: re-clicking the link on an already-opted-out customer is
 * a no-op + same success page.
 */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const customerId = url.searchParams.get('customer')
  const token = url.searchParams.get('t')

  if (!customerId || !token) {
    return new Response('Invalid opt-out link.', { status: 400 })
  }

  // Verify HMAC token (constant-time compare not strictly required for
  // this non-secret-revealing endpoint, but cleaner)
  let expected: string
  try {
    expected = billingOptOutToken(customerId)
  } catch (err) {
    console.error('[billing-opt-out] token gen failed', err)
    return new Response('Configuration error.', { status: 500 })
  }
  if (token !== expected) {
    return new Response('Invalid opt-out link.', { status: 403 })
  }

  // Verify customer exists
  const [customer] = await db
    .select({ id: customers.id, optedOutAt: customers.billingEmailsOptedOutAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  if (!customer) {
    return new Response('Account not found.', { status: 404 })
  }

  // Idempotent — set timestamp if not already set
  if (!customer.optedOutAt) {
    await db
      .update(customers)
      .set({ billingEmailsOptedOutAt: new Date() })
      .where(eq(customers.id, customerId))
    await logEvent({
      name: 'billing_emails_opted_out',
      customerId,
      properties: {},
    })
  }

  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Unsubscribed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #0f172a; }
    h1 { font-size: 24px; margin: 0 0 12px; }
    p { font-size: 16px; color: #475569; line-height: 1.5; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>You've been unsubscribed</h1>
  <p>No more billing reminders or monthly reports will be sent.</p>
  <p>Your Winback dashboard is still available — you can subscribe any time by visiting it, or disconnect Stripe from <a href="${process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'}/settings">/settings</a> if you'd rather walk away.</p>
</body>
</html>`,
    {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  )
}
