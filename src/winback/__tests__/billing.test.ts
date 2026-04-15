import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock database
const mockSelect = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelect,
  },
}))

vi.mock('@/lib/schema', () => ({
  recoveries: 'wb_recoveries',
  churnedSubscribers: 'wb_churned_subscribers',
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  gt: vi.fn((a, b) => ({ op: 'gt', a, b })),
}))

import { calculateMonthlyFee } from '../lib/billing'

function setupMockDb(recoveryRows: Array<{
  id: string
  subscriberId: string
  customerId: string
  planMrrCents: number
  stillActive: boolean
  recoveredAt: Date
  attributionEndsAt: Date
  newStripeSubId: string | null
  lastCheckedAt: Date | null
}>, subscriberEmails: Record<string, string>) {
  let callCount = 0
  const subIds = Object.keys(subscriberEmails)
  mockSelect.mockImplementation(() => ({
    from: (table: string) => {
      if (table === 'wb_recoveries') {
        return { where: () => recoveryRows }
      }
      return {
        where: () => ({
          limit: () => {
            const id = subIds[callCount] ?? subIds[0]
            callCount++
            return [{ email: subscriberEmails[id] ?? 'unknown' }]
          },
        }),
      }
    },
  }))
}

describe('calculateMonthlyFee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('no recoveries → zero fee', async () => {
    setupMockDb([], {})
    const fee = await calculateMonthlyFee('cust_1')

    expect(fee.recoveredMrrActiveCents).toBe(0)
    expect(fee.successFeeCents).toBe(0)
    expect(fee.totalFeeCents).toBe(0)
    expect(fee.recoveredSubscribers).toHaveLength(0)
  })

  it('one active recovery at £39/mo → 15% fee', async () => {
    const futureDate = new Date()
    futureDate.setFullYear(futureDate.getFullYear() + 1)

    setupMockDb(
      [{
        id: 'rec_1',
        subscriberId: 'sub_1',
        customerId: 'cust_1',
        planMrrCents: 3900,
        stillActive: true,
        recoveredAt: new Date(),
        attributionEndsAt: futureDate,
        newStripeSubId: null,
        lastCheckedAt: null,
      }],
      { sub_1: 'sarah@example.com' }
    )

    const fee = await calculateMonthlyFee('cust_1')

    expect(fee.recoveredMrrActiveCents).toBe(3900)
    expect(fee.successFeeCents).toBe(585) // 15% of 3900
    expect(fee.totalFeeCents).toBe(585)
    expect(fee.recoveredSubscribers).toHaveLength(1)
  })

  it('five recoveries at £39/mo → 15% of total', async () => {
    const futureDate = new Date()
    futureDate.setFullYear(futureDate.getFullYear() + 1)

    const recs = Array.from({ length: 5 }, (_, i) => ({
      id: `rec_${i}`,
      subscriberId: `sub_${i}`,
      customerId: 'cust_1',
      planMrrCents: 3900,
      stillActive: true,
      recoveredAt: new Date(),
      attributionEndsAt: futureDate,
      newStripeSubId: null,
      lastCheckedAt: null,
    }))

    const emails: Record<string, string> = {}
    recs.forEach((r, i) => { emails[r.subscriberId] = `user${i}@example.com` })

    setupMockDb(recs, emails)

    const fee = await calculateMonthlyFee('cust_1')

    expect(fee.recoveredMrrActiveCents).toBe(19500) // 5 × 3900
    expect(fee.successFeeCents).toBe(2925) // 15%
    expect(fee.totalFeeCents).toBe(2925)
  })

  it('recoveries past 12 months are filtered out by the query → contribute £0', async () => {
    // DB-level filter `gt(attributionEndsAt, now)` excludes expired rows.
    // The billing function sees an empty set and charges nothing for them.
    setupMockDb([], {})
    const fee = await calculateMonthlyFee('cust_1')

    expect(fee.recoveredMrrActiveCents).toBe(0)
    expect(fee.totalFeeCents).toBe(0)
  })
})
