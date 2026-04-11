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
  const fromMock = vi.fn()
  const whereMock = vi.fn()
  const limitMock = vi.fn()

  mockSelect.mockImplementation((fields?: Record<string, unknown>) => {
    return {
      from: (table: string) => {
        if (table === 'wb_recoveries') {
          return {
            where: () => recoveryRows,
          }
        }
        if (table === 'wb_churned_subscribers') {
          return {
            where: (condition: { op: string; b: string }) => ({
              limit: () => {
                // Return subscriber email based on the id passed
                const subId = Object.values(subscriberEmails).length > 0
                  ? [{ email: subscriberEmails[Object.keys(subscriberEmails)[0]] }]
                  : [{ email: 'unknown' }]

                // Simple mock: return email for any subscriber lookup
                return subId
              },
            }),
          }
        }
        return { where: () => ({ limit: () => [] }) }
      },
    }
  })

  // Override to return proper emails per subscriber
  let callCount = 0
  const subIds = Object.keys(subscriberEmails)
  mockSelect.mockImplementation(() => ({
    from: (table: string) => {
      if (table === 'wb_recoveries') {
        return { where: () => recoveryRows }
      }
      // For subscriber lookups
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

  it('no recoveries → base fee only', async () => {
    setupMockDb([], {})
    const fee = await calculateMonthlyFee('cust_1')

    expect(fee.baseFeeCents).toBe(4900)
    expect(fee.recoveredMrrActiveCents).toBe(0)
    expect(fee.successFeeCents).toBe(0)
    expect(fee.totalFeeCents).toBe(4900)
    expect(fee.recoveredSubscribers).toHaveLength(0)
  })

  it('one active recovery at £39/mo → correct success fee', async () => {
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

    expect(fee.baseFeeCents).toBe(4900)
    expect(fee.recoveredMrrActiveCents).toBe(3900)
    expect(fee.successFeeCents).toBe(390) // 10% of 3900
    expect(fee.successFeeCappedCents).toBe(390) // under cap
    expect(fee.totalFeeCents).toBe(5290) // 4900 + 390
    expect(fee.recoveredSubscribers).toHaveLength(1)
  })

  it('five recoveries at £39/mo → correct total', async () => {
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
    expect(fee.successFeeCents).toBe(1950) // 10%
    expect(fee.totalFeeCents).toBe(6850) // 4900 + 1950
  })

  it('no active recoveries returned → base fee only', async () => {
    // DB query filters out still_active=false, so empty result
    setupMockDb([], {})
    const fee = await calculateMonthlyFee('cust_1')

    expect(fee.totalFeeCents).toBe(4900)
  })
})
