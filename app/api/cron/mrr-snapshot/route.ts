import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { isNotNull } from 'drizzle-orm'
import { withCron } from '@/src/winback/lib/cron-wrap'
import { takeSnapshot } from '@/src/winback/lib/mrr-snapshot'
import { evaluateTransitionsForCustomer } from '@/src/winback/lib/tier-transitions'

export const maxDuration = 300

/**
 * Weekly MRR snapshot + tier evaluation.
 *
 * Per connected account:
 *   1. takeSnapshot — compute MRR live, persist a row to wb_mrr_snapshots.
 *   2. evaluateTransitionsForCustomer — recompute smoothed MRR, update
 *      recommended_tier (with hysteresis on downgrades), surface upgrade /
 *      downgrade prompts when sustain windows elapse, flag enterprise
 *      accounts as requires_sales.
 *
 * Connected = has stripeAccessToken (passed OAuth). Skip pre-OAuth signups.
 *
 * Runs Sunday 03:00 UTC. Weekly cadence is enough because:
 *   - MRR doesn't shift fast.
 *   - Tier transitions take 14d / 30d sustain windows to fire.
 *   - Webhook-driven snapshots fill in density when subscriptions change.
 *
 * `?dryRun=1` runs the full computation (Stripe read + tier resolution)
 * but skips both the snapshot INSERT and the customer-row UPDATE.
 * Returns per-customer results so ops can preview what the real run
 * would change BEFORE letting it touch the tables.
 *
 * Caveat: in dry-run mode the smoothed MRR used for tier evaluation
 * does NOT include the just-computed snapshot (since it was never
 * persisted). For accounts with a sparse snapshot history this can
 * produce slightly different recommendations than the real run. Adding
 * a single new data point to a 30d window rarely shifts the median
 * across a tier boundary, but treat dry-run output as directional, not
 * pixel-perfect.
 *
 * Auth: Bearer ${CRON_SECRET} via withCron (Spec 69).
 */
export const GET = (req: NextRequest) =>
  withCron('mrr-snapshot', req, async () => {
    const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'

    const connected = await db
      .select({ id: customers.id })
      .from(customers)
      .where(isNotNull(customers.stripeAccessToken))

    let snapshotOk = 0
    let snapshotSkipped = 0
    let snapshotErrored = 0
    let evaluations = 0
    let enterpriseFlagged = 0
    let promptsDue = 0

    type PreviewRow = {
      customerId: string
      mrrUsdMinor: number | null
      oldRecommended: string | null
      wouldBeRecommended: string | null
      wouldFlagEnterprise: boolean
      upgradePromptDue: boolean
      downgradePromptDue: boolean
      error?: string
      skipped?: string
    }
    const preview: PreviewRow[] = []

    for (const c of connected) {
      const snap = await takeSnapshot(c.id, 'weekly_cron', { dryRun })
      if (snap.ok) snapshotOk += 1
      else if (snap.reason === 'no_token') snapshotSkipped += 1
      else snapshotErrored += 1

      const evalResult = await evaluateTransitionsForCustomer(c.id, { dryRun })
      evaluations += 1
      if (evalResult.enterpriseNewlyFlagged) enterpriseFlagged += 1
      if (evalResult.upgradePromptDue || evalResult.downgradePromptDue) {
        promptsDue += 1
      }

      if (dryRun) {
        preview.push({
          customerId: c.id,
          mrrUsdMinor: snap.ok ? snap.mrrUsdMinor : null,
          oldRecommended: evalResult.oldRecommended,
          wouldBeRecommended: evalResult.newRecommended,
          wouldFlagEnterprise: evalResult.enterpriseNewlyFlagged,
          upgradePromptDue: evalResult.upgradePromptDue,
          downgradePromptDue: evalResult.downgradePromptDue,
          error: snap.ok ? undefined : snap.error,
          skipped:
            evalResult.skipped !== false ? evalResult.skipped : undefined,
        })
      }
    }

    return {
      dryRun,
      connectedCount: connected.length,
      snapshotOk,
      snapshotSkipped,
      snapshotErrored,
      evaluations,
      enterpriseFlagged,
      promptsDue,
      ...(dryRun ? { preview } : {}),
    }
  })
