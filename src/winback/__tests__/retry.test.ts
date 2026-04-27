import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { callWithRetry } from '../lib/retry'

/**
 * Spec 28 — callWithRetry behaviour.
 *
 * 429s with `retry-after` are absorbed (sleep, retry); other errors bubble
 * up immediately so the caller's existing handler sees them. Sleeps are
 * mocked via fake timers so the suite runs in milliseconds.
 */
describe('callWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function buildErr(status: number, headers?: Record<string, string>) {
    const err = new Error(`status ${status}`) as Error & {
      status?: number
      headers?: Record<string, string>
    }
    err.status = status
    err.headers = headers
    return err
  }

  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await callWithRetry(fn, { ctx: 'test' })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('non-429 error bubbles up immediately, no retry', async () => {
    const err500 = buildErr(500)
    const fn = vi.fn().mockRejectedValue(err500)
    await expect(callWithRetry(fn, { ctx: 'test' })).rejects.toBe(err500)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('429 with retry-after sleeps then retries; eventual success returns', async () => {
    const err429 = buildErr(429, { 'retry-after': '2' })
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce('eventually-ok')

    const promise = callWithRetry(fn, { ctx: 'test' })
    // Advance the 2s sleep + the small min-clamp.
    await vi.advanceTimersByTimeAsync(2_500)
    await expect(promise).resolves.toBe('eventually-ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('honours upper-case Retry-After header', async () => {
    const err429 = buildErr(429, { 'Retry-After': '1' })
    const fn = vi.fn().mockRejectedValueOnce(err429).mockResolvedValueOnce('ok')

    const promise = callWithRetry(fn, { ctx: 'test' })
    await vi.advanceTimersByTimeAsync(1_500)
    await expect(promise).resolves.toBe('ok')
  })

  it('caps individual sleep at 60s even if Stripe says 600', async () => {
    const err429 = buildErr(429, { 'retry-after': '600' })
    const fn = vi.fn().mockRejectedValueOnce(err429).mockResolvedValueOnce('ok')

    const promise = callWithRetry(fn, { ctx: 'test' })
    // Sleep should be exactly 60s, not 600s.
    await vi.advanceTimersByTimeAsync(60_500)
    await expect(promise).resolves.toBe('ok')
  })

  it('falls back to default 5s sleep when retry-after header missing', async () => {
    const err429 = buildErr(429)
    const fn = vi.fn().mockRejectedValueOnce(err429).mockResolvedValueOnce('ok')

    const promise = callWithRetry(fn, { ctx: 'test' })
    await vi.advanceTimersByTimeAsync(5_500)
    await expect(promise).resolves.toBe('ok')
  })

  it('exhausting maxRetries re-throws the last 429 error', async () => {
    const err429 = buildErr(429, { 'retry-after': '1' })
    const fn = vi.fn().mockRejectedValue(err429)

    const promise = callWithRetry(fn, { ctx: 'test', maxRetries: 2 })
    // Attach a rejection handler before any synchronous test failure can
    // surface to avoid unhandled-rejection noise.
    const result = expect(promise).rejects.toBe(err429)
    await vi.advanceTimersByTimeAsync(10_000)
    await result
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
