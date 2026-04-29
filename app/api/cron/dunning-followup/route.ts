import { NextRequest, NextResponse } from 'next/server'
import { runDunningTouches } from '@/src/winback/lib/dunning-followup'

export const maxDuration = 60

/**
 * Spec 33 — Multi-touch dunning cron.
 *
 * Daily 08:00 UTC sweep that sends T2 / T3 dunning emails ~24h before
 * Stripe's next retry attempt. Two passes inside one helper:
 *
 *   T2: dunning_state='awaiting_retry'       AND touch_count=1
 *   T3: dunning_state='final_retry_pending'  AND touch_count=2
 *
 * State is set by the invoice.payment_failed webhook handler on every
 * retry event (Spec 33 webhook changes). When Stripe gives up
 * (next_payment_attempt: null) state flips to 'churned_during_dunning'
 * and the cron stops touching the row — win-back (Spec 04) takes over.
 *
 * Auth: Bearer ${CRON_SECRET}, identical to /api/cron/reengagement.
 *
 * `?dryRun=1` skips sends + DB writes, returns processed counts only.
 * Use this on the first prod run to audit the eligible cohort.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'

  const { t2, t3 } = await runDunningTouches({ dryRun })

  console.log('[cron/dunning-followup]', { dryRun, t2, t3 })

  return NextResponse.json({ t2, t3, dryRun })
}
