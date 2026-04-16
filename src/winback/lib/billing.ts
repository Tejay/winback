import { db } from '@/lib/db'
import { recoveries, churnedSubscribers } from '@/lib/schema'
import { eq, and, gt } from 'drizzle-orm'
import { BILLABLE_ATTRIBUTION, SUCCESS_FEE_RATE as BILLING_RATE } from './obligations'

export interface MonthlyFee {
  recoveredMrrActiveCents: number
  successFeeCents:         number
  totalFeeCents:           number
  recoveredSubscribers: Array<{
    email:       string
    mrrCents:    number
    recoveredAt: Date
    stillActive: boolean
  }>
}

// Pricing: 15% of recovered MRR, 12-month attribution per subscriber.
// No base fee, no cap.
//
// We only bill recoveries with `attributionType = BILLABLE_ATTRIBUTION`
// (currently 'strong' — the subscriber clicked a tracked Winback link).
// "Weak" recoveries are shown in the dashboard but never invoiced — see
// `obligations.ts` for the policy and `/faq` for the founder-facing
// explanation. The attribution window (12 months) is enforced by the
// `attributionEndsAt` filter below — rows past that date fall out
// of the billed set automatically.
const SUCCESS_FEE_RATE = BILLING_RATE

export async function calculateMonthlyFee(customerId: string): Promise<MonthlyFee> {
  const now = new Date()

  // Get all billable recoveries where attribution hasn't expired
  const activeRecoveries = await db
    .select()
    .from(recoveries)
    .where(
      and(
        eq(recoveries.customerId, customerId),
        eq(recoveries.stillActive, true),
        eq(recoveries.attributionType, BILLABLE_ATTRIBUTION),
        gt(recoveries.attributionEndsAt, now)
      )
    )

  const recoveredSubscribersList: MonthlyFee['recoveredSubscribers'] = []
  let recoveredMrrActiveCents = 0

  for (const rec of activeRecoveries) {
    const [sub] = await db
      .select({ email: churnedSubscribers.email })
      .from(churnedSubscribers)
      .where(eq(churnedSubscribers.id, rec.subscriberId))
      .limit(1)

    recoveredMrrActiveCents += rec.planMrrCents

    recoveredSubscribersList.push({
      email: sub?.email ?? 'unknown',
      mrrCents: rec.planMrrCents,
      recoveredAt: rec.recoveredAt ?? new Date(),
      stillActive: true,
    })
  }

  const successFeeCents = Math.round(recoveredMrrActiveCents * SUCCESS_FEE_RATE)
  const totalFeeCents = successFeeCents

  return {
    recoveredMrrActiveCents,
    successFeeCents,
    totalFeeCents,
    recoveredSubscribers: recoveredSubscribersList,
  }
}
