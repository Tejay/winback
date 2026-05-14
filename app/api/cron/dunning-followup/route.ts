import { NextRequest } from 'next/server'
import { runDunningTouches } from '@/src/winback/lib/dunning-followup'
import { withCron } from '@/src/winback/lib/cron-wrap'

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
 * Auth: Bearer ${CRON_SECRET} via withCron (Spec 69).
 *
 * `?dryRun=1` skips sends + DB writes, returns processed counts only.
 * Use this on the first prod run to audit the eligible cohort.
 */
export const GET = (req: NextRequest) =>
  withCron('dunning-followup', req, async () => {
    const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
    const { t2, t3 } = await runDunningTouches({ dryRun })
    console.log('[cron/dunning-followup]', { dryRun, t2, t3 })
    return { dryRun, t2, t3 }
  })
