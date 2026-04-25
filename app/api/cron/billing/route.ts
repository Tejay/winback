import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { isNotNull } from 'drizzle-orm'
import { previousMonthYYYYMM } from '@/src/winback/lib/platform-billing'
import { processBillingRun } from '@/src/winback/lib/billing'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 24a — Monthly invoice cron.
 *
 * Runs via Vercel cron on the 1st of each month at 00:00 UTC. Bills in
 * arrears: on June 1st we invoice for recoveries active during May.
 *
 * Per-customer logic lives in `processBillingRun` (src/winback/lib/billing.ts)
 * — single source of truth shared with the admin retry endpoint (spec 26).
 * This handler just loops over candidate customers and tallies outcomes.
 */
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const period = previousMonthYYYYMM()

  // Candidate customers: any with a platform Stripe customer (has been
  // billable at some point). processBillingRun handles the per-customer
  // skip cases (no card, no obligations, already billed).
  const candidates = await db
    .select({ id: customers.id })
    .from(customers)
    .where(isNotNull(customers.stripePlatformCustomerId))

  let processed = 0
  let created = 0
  let skipped = 0
  let errors = 0

  for (const cust of candidates) {
    processed++
    try {
      const result = await processBillingRun(cust.id, period)
      if (result.outcome === 'created') created++
      else if (result.outcome === 'error') errors++
      else skipped++   // skipped_no_card | skipped_no_obligations | already_billed
    } catch (err) {
      // processBillingRun catches its own errors and returns outcome: 'error',
      // but be defensive against unexpected throws from the helper itself.
      errors++
      console.error(`[billing-cron] Unexpected error for customer ${cust.id}:`, err)
    }
  }

  await logEvent({
    name: 'billing_cron_complete',
    properties: { period, processed, created, skipped, errors },
  })

  console.log(
    `[billing-cron] period=${period} processed=${processed} created=${created} skipped=${skipped} errors=${errors}`,
  )

  return NextResponse.json({ period, processed, created, skipped, errors })
}
