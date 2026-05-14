import { NextRequest } from 'next/server'
import {
  runOnboardingNudges,
  runDeletionWarnings,
  runStaleAccountPrune,
} from '@/src/winback/lib/onboarding-followup'
import { runPilotEndingWarnings } from '@/src/winback/lib/pilot'
import { withCron } from '@/src/winback/lib/cron-wrap'

export const maxDuration = 60

/**
 * Founder-lifecycle cron — single daily orchestration for everything
 * touching the founder account row.
 *
 * Four sequential passes:
 *   A. Day-3 onboarding nudge       → onboarding_nudge_sent           (Spec 30)
 *   B. Day-83 deletion warning      → onboarding_deletion_warning_sent (Spec 30)
 *   C. Day-90 cascade prune         → onboarding_account_pruned        (Spec 30)
 *   D. Day-23 pilot heads-up        → pilot_ending_soon_sent           (Spec 31)
 *
 * Schedule: daily at 09:30 UTC via vercel.json (offset from the 09:00
 * reengagement cron so logs interleave cleanly).
 *
 * Auth: Bearer ${CRON_SECRET} via withCron (Spec 69).
 *
 * `?dryRun=1` skips sends and deletes, returns processed counts only.
 * USE THIS FOR THE FIRST PROD RUN to audit which accounts will be touched.
 */
export const GET = (req: NextRequest) =>
  withCron('onboarding-followup', req, async () => {
    const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
    const nudges        = await runOnboardingNudges({ dryRun })
    const warnings      = await runDeletionWarnings({ dryRun })
    const deletes       = await runStaleAccountPrune({ dryRun })
    const pilotWarnings = await runPilotEndingWarnings({ dryRun })
    console.log('[cron/onboarding-followup]', { dryRun, nudges, warnings, deletes, pilotWarnings })
    return { dryRun, nudges, warnings, deletes, pilotWarnings }
  })
