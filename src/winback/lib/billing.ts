import { db } from '@/lib/db'
import { recoveries, churnedSubscribers } from '@/lib/schema'
import { eq, and, gt } from 'drizzle-orm'

export interface MonthlyFee {
  baseFeeCents:            number
  recoveredMrrActiveCents: number
  successFeeCents:         number
  successFeeCappedCents:   number
  totalFeeCents:           number
  recoveredSubscribers: Array<{
    email:       string
    mrrCents:    number
    recoveredAt: Date
    stillActive: boolean
  }>
}

const BASE_FEE_CENTS = 4900 // £49
const SUCCESS_FEE_RATE = 0.10
const SUCCESS_FEE_CAP_CENTS = 50000 // £500

export async function calculateMonthlyFee(customerId: string): Promise<MonthlyFee> {
  const now = new Date()

  // Get all recoveries where attribution hasn't expired
  const activeRecoveries = await db
    .select()
    .from(recoveries)
    .where(
      and(
        eq(recoveries.customerId, customerId),
        eq(recoveries.stillActive, true),
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
  const successFeeCappedCents = Math.min(successFeeCents, SUCCESS_FEE_CAP_CENTS)
  const totalFeeCents = BASE_FEE_CENTS + successFeeCappedCents

  return {
    baseFeeCents: BASE_FEE_CENTS,
    recoveredMrrActiveCents,
    successFeeCents,
    successFeeCappedCents,
    totalFeeCents,
    recoveredSubscribers: recoveredSubscribersList,
  }
}
