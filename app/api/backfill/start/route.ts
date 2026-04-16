import { NextRequest, NextResponse } from 'next/server'
import { backfillCancellations } from '@/src/winback/lib/backfill'

/**
 * Internal-only endpoint to trigger historical backfill.
 * Authenticated with CRON_SECRET — not user-facing.
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
    await backfillCancellations(customerId)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Backfill failed:', err)
    return NextResponse.json(
      { error: 'Backfill failed', message: String(err) },
      { status: 500 }
    )
  }
}
