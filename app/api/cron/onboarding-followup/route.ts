import { NextRequest, NextResponse } from 'next/server'
import {
  runOnboardingNudges,
  runDeletionWarnings,
  runStaleAccountPrune,
} from '@/src/winback/lib/onboarding-followup'

export const maxDuration = 60

/**
 * Spec 30 — Daily cron for partially-onboarded founders (registered but
 * never connected Stripe).
 *
 * Three sequential passes:
 *   A. Day-3 nudge        → onboarding_nudge_sent
 *   B. Day-83 warning     → onboarding_deletion_warning_sent
 *   C. Day-90 cascade prune (deletes wb_users + cascades)
 *
 * Schedule: daily at 09:30 UTC via vercel.json (offset from the 09:00
 * reengagement cron so logs interleave cleanly).
 *
 * Auth: Bearer ${CRON_SECRET}, identical to /api/cron/reengagement.
 *
 * `?dryRun=1` skips sends and deletes, returns processed counts only.
 * USE THIS FOR THE FIRST PROD RUN to audit which dormant accounts will
 * be touched.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'

  const nudges   = await runOnboardingNudges({ dryRun })
  const warnings = await runDeletionWarnings({ dryRun })
  const deletes  = await runStaleAccountPrune({ dryRun })

  console.log('[cron/onboarding-followup]', {
    dryRun,
    nudges,
    warnings,
    deletes,
  })

  return NextResponse.json({ nudges, warnings, deletes, dryRun })
}
