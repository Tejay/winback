/**
 * Mid-life tier evaluation — recomputes recommended_tier from smoothed
 * MRR, applies hysteresis on downgrades, and fires upgrade/downgrade
 * prompts when their sustain windows elapse.
 *
 * Called per-customer from the weekly MRR snapshot cron. Decoupled from
 * the snapshot writer so a recompute can be triggered from anywhere
 * (admin scripts, debug routes, future on-demand path).
 *
 * Key invariants:
 *
 *   - We NEVER change billed_tier here. Only the customer can — via the
 *     activation page or Stripe Customer Portal. This function only
 *     updates recommended_tier and decides whether to surface a prompt.
 *
 *   - recommended_changed_at updates only when recommended_tier actually
 *     changes. That naturally damps flapping: a customer whose smoothed
 *     MRR oscillates around a boundary will see recommended_tier toggle
 *     but the sustain check (now - changed_at >= N days) will never
 *     trigger because changed_at keeps resetting.
 *
 *   - Enterprise short-circuits to requires_sales + alert. No
 *     customer-facing prompt — the surface is "contact sales" and
 *     handoff happens out-of-band.
 *
 *   - Customers with customMonthlyCents set are NOT re-evaluated — they
 *     are on a negotiated price and tier movement should not surface
 *     prompts.
 */

import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { computeSmoothed } from './mrr-snapshot'
import {
  tierFromMrrWithHysteresis,
  tierRank,
  type TierKey,
} from './tiers'
import {
  UPGRADE_SUSTAIN_DAYS,
  DOWNGRADE_SUSTAIN_DAYS,
} from './billing-config'
import { emitInternalAlert } from './internal-alert'

export type TransitionEvaluation = {
  customerId: string
  smoothedMrrUsdMinor: number | null
  oldRecommended: TierKey | null
  newRecommended: TierKey | null
  billedTier: TierKey | null
  /** True iff the upgrade-prompt sustain window has elapsed. */
  upgradePromptDue: boolean
  /** True iff the downgrade-prompt sustain window has elapsed. */
  downgradePromptDue: boolean
  /** True iff this evaluation flipped requires_sales from false to true. */
  enterpriseNewlyFlagged: boolean
  /** Skipped for a structural reason (no token, customMonthlyCents, pilot). */
  skipped: false | 'no_snapshots' | 'custom_rate' | 'pilot'
}

const VALID_TIERS: ReadonlyArray<TierKey> = [
  'starter',
  'growth',
  'scale',
  'enterprise',
]

function asTierKey(value: string | null): TierKey | null {
  if (!value) return null
  return (VALID_TIERS as readonly string[]).includes(value)
    ? (value as TierKey)
    : null
}

export async function evaluateTransitionsForCustomer(
  customerId: string,
  opts: { dryRun?: boolean } = {},
): Promise<TransitionEvaluation> {
  const rows = await db
    .select({
      id: customers.id,
      recommendedTier: customers.recommendedTier,
      billedTier: customers.billedTier,
      smoothedMrrUsdMinor: customers.smoothedMrrUsdMinor,
      recommendedChangedAt: customers.recommendedChangedAt,
      requiresSales: customers.requiresSales,
      customMonthlyCents: customers.customMonthlyCents,
      pilotUntil: customers.pilotUntil,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  const row = rows[0]
  if (!row) {
    return blankEvaluation(customerId, 'no_snapshots')
  }

  // customMonthlyCents customers are on negotiated pricing — do not
  // recompute or surface prompts for them.
  if (row.customMonthlyCents !== null && row.customMonthlyCents !== undefined) {
    return blankEvaluation(customerId, 'custom_rate')
  }

  // Pilot customers — same rationale. Snapshots are still taken so
  // recommended_tier is hot the moment the pilot ends.
  if (row.pilotUntil && new Date(row.pilotUntil).getTime() > Date.now()) {
    return blankEvaluation(customerId, 'pilot')
  }

  const smoothed = await computeSmoothed(customerId)
  if (smoothed === null) {
    return blankEvaluation(customerId, 'no_snapshots')
  }

  const oldRecommended = asTierKey(row.recommendedTier)
  const billed = asTierKey(row.billedTier)
  const newRecommended = tierFromMrrWithHysteresis(smoothed, billed)

  const recommendedChanged = oldRecommended !== newRecommended
  const enterpriseNewlyFlagged =
    newRecommended === 'enterprise' && !row.requiresSales

  const now = new Date()
  const patch: Partial<typeof customers.$inferInsert> = {
    smoothedMrrUsdMinor: smoothed,
    smoothedMrrComputedAt: now,
    updatedAt: now,
  }
  if (recommendedChanged) {
    patch.recommendedTier = newRecommended
    patch.recommendedChangedAt = now
  }
  if (enterpriseNewlyFlagged) {
    patch.requiresSales = true
  }

  if (!opts.dryRun) {
    await db.update(customers).set(patch).where(eq(customers.id, customerId))

    if (enterpriseNewlyFlagged) {
      await emitInternalAlert({
        severity: 'info',
        title: 'Customer crossed into Enterprise tier',
        details: {
          customerId,
          smoothedMrrUsdMinor: smoothed,
          smoothedMrrUsd: smoothed / 100,
        },
      })
    }
  }

  // Sustain-window check — does the current recommended_tier diverge
  // from billed_tier AND has it been that way long enough to surface a
  // prompt?
  const changedAt = recommendedChanged
    ? now
    : row.recommendedChangedAt ?? null
  const daysSinceChange = changedAt
    ? (now.getTime() - new Date(changedAt).getTime()) / (1000 * 60 * 60 * 24)
    : 0

  let upgradePromptDue = false
  let downgradePromptDue = false
  if (billed && newRecommended && newRecommended !== billed) {
    const direction =
      tierRank(newRecommended) > tierRank(billed) ? 'up' : 'down'
    if (direction === 'up' && daysSinceChange >= UPGRADE_SUSTAIN_DAYS) {
      upgradePromptDue = true
    }
    if (direction === 'down' && daysSinceChange >= DOWNGRADE_SUSTAIN_DAYS) {
      downgradePromptDue = true
    }
  }

  return {
    customerId,
    smoothedMrrUsdMinor: smoothed,
    oldRecommended,
    newRecommended,
    billedTier: billed,
    upgradePromptDue,
    downgradePromptDue,
    enterpriseNewlyFlagged,
    skipped: false,
  }
}

function blankEvaluation(
  customerId: string,
  skipped: 'no_snapshots' | 'custom_rate' | 'pilot',
): TransitionEvaluation {
  return {
    customerId,
    smoothedMrrUsdMinor: null,
    oldRecommended: null,
    newRecommended: null,
    billedTier: null,
    upgradePromptDue: false,
    downgradePromptDue: false,
    enterpriseNewlyFlagged: false,
    skipped,
  }
}
