import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockInsert = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db', () => ({
  db: { insert: mockInsert },
}))

vi.mock('@/lib/schema', () => ({
  wbEvents: 'wb_events',
}))

import { logEvent } from '../lib/events'

describe('logEvent', () => {
  beforeEach(() => {
    mockInsert.mockReset()
    // Default: insert resolves successfully.
    mockInsert.mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) })
  })

  it('writes a row with the given name and default empty properties', async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    mockInsert.mockReturnValue({ values })

    await logEvent({ name: 'onboarding_stripe_viewed', customerId: 'cust-1', userId: 'user-1' })

    expect(mockInsert).toHaveBeenCalledWith('wb_events')
    expect(values).toHaveBeenCalledWith({
      name: 'onboarding_stripe_viewed',
      customerId: 'cust-1',
      userId: 'user-1',
      properties: {},
    })
  })

  it('passes through custom properties', async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    mockInsert.mockReturnValue({ values })

    await logEvent({
      name: 'oauth_denied',
      customerId: 'cust-1',
      properties: { errorType: 'denied' },
    })

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ properties: { errorType: 'denied' } }),
    )
  })

  it('accepts events with no customer or user (pre-auth pageviews)', async () => {
    const values = vi.fn().mockResolvedValue(undefined)
    mockInsert.mockReturnValue({ values })

    await logEvent({ name: 'landing_viewed' })

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: null, userId: null }),
    )
  })

  it('swallows DB errors so telemetry never breaks the user flow', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockInsert.mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error('db down')),
    })

    // Must not throw.
    await expect(logEvent({ name: 'oauth_completed' })).resolves.toBeUndefined()

    expect(consoleSpy).toHaveBeenCalledWith(
      '[events] logEvent failed',
      expect.objectContaining({ name: 'oauth_completed', error: 'db down' }),
    )
    consoleSpy.mockRestore()
  })
})
