import { NextRequest, NextResponse } from 'next/server'
import {
  runOnboardingNudges,
  runDeletionWarnings,
  runStaleAccountPrune,
} from '@/src/winback/lib/onboarding-followup'
import { runPilotEndingWarnings } from '@/src/winback/lib/pilot'

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
 * Auth: Bearer ${CRON_SECRET}, identical to /api/cron/reengagement.
 *
 * `?dryRun=1` skips sends and deletes, returns processed counts only.
 * USE THIS FOR THE FIRST PROD RUN to audit which accounts will be touched.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'

  const nudges        = await runOnboardingNudges({ dryRun })
  const warnings      = await runDeletionWarnings({ dryRun })
  const deletes       = await runStaleAccountPrune({ dryRun })
  const pilotWarnings = await runPilotEndingWarnings({ dryRun })

  console.log('[cron/onboarding-followup]', {
    dryRun,
    nudges,
    warnings,
    deletes,
    pilotWarnings,
  })

  return NextResponse.json({ nudges, warnings, deletes, pilotWarnings, dryRun })
}
