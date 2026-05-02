/**
 * Spec 41 — Cumulative revenue saved (pure helper).
 *
 * For each recovery, count whole 30-day months the subscriber stayed
 * subscribed past `recoveredAt`, multiply by `mrrCents` recorded at
 * recovery time, sum across all recoveries.
 *
 * Floored to whole months — conservative. A subscriber recovered
 * yesterday contributes 0 until they've actually been billed for a
 * full cycle. A subscriber recovered 95 days ago contributes 3 ×
 * mrrCents (not 3.16). This avoids crediting Winback for "revenue
 * saved" on a customer who hasn't yet paid an invoice.
 *
 * MRR is taken from the recovery row, not chased through plan changes.
 * Slight understate if the subscriber upgraded post-recovery; slight
 * overstate if they downgraded. Acceptable — exact tracking would
 * require per-invoice audit which is out of scope for v1.
 */

export type RecoveryForRevenue = {
  /** Stripe subscription id at recovery time. Used to look up re-churn. */
  subscriptionId: string | null
  /** MRR recorded on the recovery row (in cents). */
  mrrCents: number
  /** When the recovery happened. */
  recoveredAt: Date
}

export type SubscriberLifecycle = {
  /** When the subscriber re-churned after recovery. Null = still subscribed. */
  reChurnedAt: Date | null
}

const DAYS_PER_MONTH = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * @param recoveries  All recoveries for the customer.
 * @param lifecycles  Map keyed by stripe subscription id → re-churn timestamp
 *                    (or null = still subscribed). Caller builds this from
 *                    `wb_churned_subscribers` rows where cancelledAt is set.
 *                    Recoveries with no entry (or with subscriptionId=null)
 *                    are treated as still-subscribed.
 * @param asOf        "Now" — extracted as a parameter so tests can pin it.
 */
export function computeCumulativeRevenueSavedCents(
  recoveries: RecoveryForRevenue[],
  lifecycles: Map<string, SubscriberLifecycle>,
  asOf: Date,
): number {
  let total = 0
  for (const r of recoveries) {
    const lifecycle = r.subscriptionId ? lifecycles.get(r.subscriptionId) : undefined
    // Retention end = next re-churn after recovery, OR `asOf` if still subscribed.
    // If a re-churn happened BEFORE the recovery (older lifecycle event), ignore
    // it — that re-churn is a different segment. Compare against recoveredAt.
    const reChurnedAt = lifecycle?.reChurnedAt
    const retentionEnd =
      reChurnedAt && reChurnedAt > r.recoveredAt ? reChurnedAt : asOf

    const days = Math.floor((retentionEnd.getTime() - r.recoveredAt.getTime()) / MS_PER_DAY)
    if (days < DAYS_PER_MONTH) continue  // < 1 whole month, contributes 0
    const months = Math.floor(days / DAYS_PER_MONTH)
    total += months * r.mrrCents
  }
  return total
}
