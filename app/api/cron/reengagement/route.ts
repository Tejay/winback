import { NextRequest } from 'next/server'
import { runReengagementCronV2 } from '@/src/winback/lib/reengagement-cron-v2'
import { withCron } from '@/src/winback/lib/cron-wrap'

export const maxDuration = 60

/**
 * Daily cron — re-engages cancelled subscribers when one of the
 * merchant's published improvements (Spec 65) matches their stated
 * reason for leaving.
 *
 * Pipeline lives in src/winback/lib/reengagement-cron-v2.ts.
 *
 * Schedule: daily at 09:00 UTC via vercel.json
 * Auth: Bearer ${CRON_SECRET} via withCron (Spec 69).
 */
export const GET = (req: NextRequest) =>
  withCron('reengagement', req, async () => {
    const stats = await runReengagementCronV2()
    return { stats }
  })
