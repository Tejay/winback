import { NextRequest, NextResponse } from 'next/server'
import { runReengagementCronV2 } from '@/src/winback/lib/reengagement-cron-v2'

export const maxDuration = 60

/**
 * Daily cron — re-engages cancelled subscribers when one of the
 * merchant's published improvements (Spec 65) matches their stated
 * reason for leaving.
 *
 * Pipeline lives in src/winback/lib/reengagement-cron-v2.ts.
 *
 * Schedule: daily at 09:00 UTC via vercel.json
 */
export async function GET(req: NextRequest) {
  // Verify this is called by Vercel Cron (or internal trigger)
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const stats = await runReengagementCronV2()
  return NextResponse.json({ ok: true, stats })
}
