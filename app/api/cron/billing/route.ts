import { NextRequest, NextResponse } from 'next/server'

/**
 * Phase B — Deprecated.
 *
 * Billing is now driven by Stripe Subscriptions ($99/mo platform fee with
 * win-back fees attached as one-off invoice items). Stripe handles the
 * cycle, dunning, and retries. This route used to invoice customers
 * monthly under the old 15% × 12-month model.
 *
 * The Vercel cron schedule entry in vercel.json continues to ping this
 * endpoint (no-op below) until Phase C deletes both the schedule and this
 * file. Returning 200 keeps the cron green so it doesn't generate alerts.
 */
export async function GET(_req: NextRequest) {
  return NextResponse.json({
    deprecated: true,
    message:
      'Billing is now driven by Stripe Subscriptions. This cron is retained as a no-op until Phase C cleanup.',
  })
}
