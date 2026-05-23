/**
 * One-shot FX rate populator. Same body as /api/cron/fx-refresh but
 * runnable without booting the dev server.
 *
 *   tsx --env-file=.env.local scripts/fx-refresh-once.ts
 */

import { refreshAllRates } from '../src/winback/lib/fx'

async function main(): Promise<void> {
  console.log('[fx-refresh-once] starting')
  const result = await refreshAllRates()
  if (result.ok) {
    console.log(`[fx-refresh-once] ok — ${result.currenciesUpdated} currencies updated`)
  } else {
    console.error(`[fx-refresh-once] failed — ${result.error}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[fx-refresh-once] unexpected error', err)
  process.exit(1)
})
