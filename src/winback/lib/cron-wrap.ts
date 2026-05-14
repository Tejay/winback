import { NextResponse } from 'next/server'
import { logEvent } from './events'

/**
 * Spec 69 — standardised cron handler wrapper.
 *
 * Does three things every cron route used to do by hand, plus one new:
 *   1. Verify the `Authorization: Bearer ${CRON_SECRET}` header.
 *   2. Run the body.
 *   3. Return a JSON 200 with `{ ok: true, ...result }` or re-throw on error.
 *   4. Emit a `cron_run` event with name + durationMs + ok flag + (on
 *      failure) errorMessage. The admin Overview reads this to render
 *      the cron health table.
 *
 * Each cron route reduces to:
 *
 *     export const GET = (req: NextRequest) =>
 *       withCron('reengagement', req, () => runReengagementCronV2())
 */
export async function withCron<T>(
  name: string,
  req: Request,
  fn: () => Promise<T>,
): Promise<Response> {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const start = Date.now()
  try {
    const result = await fn()
    await logEvent({
      name: 'cron_run',
      properties: {
        name,
        ok: true,
        durationMs: Date.now() - start,
      },
    })
    return NextResponse.json({ ok: true, ...(result as object | undefined ?? {}) })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    // Best-effort: if event-log writes fail (DB unreachable), still re-raise
    // so Vercel records the cron as failed.
    try {
      await logEvent({
        name: 'cron_run',
        properties: {
          name,
          ok: false,
          durationMs: Date.now() - start,
          errorMessage,
        },
      })
    } catch { /* swallow */ }
    throw err
  }
}
