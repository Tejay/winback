import { NextRequest } from 'next/server'
import { withCron } from '@/src/winback/lib/cron-wrap'
import { refreshAllRates } from '@/src/winback/lib/fx'
import { emitInternalAlert } from '@/src/winback/lib/internal-alert'

export const maxDuration = 30

/**
 * Daily FX rate refresh.
 *
 * Pulls USD-base rates from the provider, upserts into wb_fx_rates. Runs
 * at 02:00 UTC so the MRR snapshot cron (03:00 UTC Sunday weekly) and any
 * activation-time live reads use fresh rates.
 *
 * On provider failure: previously cached rates remain usable; the MRR
 * computation will continue running on them and only flag if a rate goes
 * stale (>7d). An admin alert fires here so ops can investigate.
 *
 * Auth: Bearer ${CRON_SECRET} via withCron (Spec 69).
 */
export const GET = (req: NextRequest) =>
  withCron('fx-refresh', req, async () => {
    const result = await refreshAllRates()
    if (!result.ok) {
      await emitInternalAlert({
        severity: 'warning',
        title: 'FX provider refresh failed',
        details: { error: result.error },
      })
      return { ok: false, error: result.error }
    }
    return { currenciesUpdated: result.currenciesUpdated }
  })
