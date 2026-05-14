import { NextRequest, NextResponse } from 'next/server'
import { runInitialBackfillBurst } from '@/src/winback/lib/backfill'

/**
 * Internal-only endpoint that runs the initial backfill burst for one
 * customer right after Stripe OAuth. Spec 72 split the old monolithic
 * backfillCancellations into per-tick chunks; this endpoint now drives
 * the first 1-2 ticks in-process so the merchant sees rows appear
 * fast. The /api/cron/backfill-ingest cron continues from there.
 *
 * Authenticated with CRON_SECRET — only the OAuth callback calls it.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`

  if (!authHeader || authHeader !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { customerId } = body

  if (!customerId || typeof customerId !== 'string') {
    return NextResponse.json({ error: 'customerId required' }, { status: 400 })
  }

  try {
    await runInitialBackfillBurst(customerId)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Initial backfill burst failed:', err)
    return NextResponse.json(
      { error: 'Backfill burst failed', message: String(err) },
      { status: 500 }
    )
  }
}
