/**
 * Spec 28 — 429-aware retry wrapper.
 *
 * Wraps a single async call to a third-party (Anthropic, Resend, Stripe)
 * and translates HTTP 429 ("rate-limited") into bounded waits + retries
 * instead of immediate throws.
 *
 * Honours the `retry-after` response header when present (caps individual
 * sleeps at 60s). All other errors bubble up immediately so the caller's
 * existing try/catch handles them as today.
 *
 * Bounded: max 3 retries per call (4 total attempts). The function-level
 * Vercel timeout is 300s; even at the max sleep cap of 60s we'd never
 * exceed it.
 */

interface RetryOpts {
  ctx: string
  maxRetries?: number
}

interface ErrorWithStatus {
  status?: number
  headers?: Record<string, string | undefined>
}

const DEFAULT_RETRY_AFTER_SECS = 5
const MAX_SLEEP_MS = 60_000
const MIN_SLEEP_MS = 1_000

export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts,
): Promise<T> {
  const { ctx, maxRetries = 3 } = opts
  let lastErr: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as ErrorWithStatus | null)?.status
      if (status !== 429) {
        // Non-429: bubble up, caller's existing handler takes over.
        throw err
      }
      if (attempt === maxRetries) {
        // Out of retries — bubble the last 429 up.
        break
      }
      const headers = (err as ErrorWithStatus | null)?.headers ?? {}
      const retryAfterRaw = headers['retry-after'] ?? headers['Retry-After']
      const retryAfterSecs = Number(retryAfterRaw)
      const safeSecs =
        Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
          ? retryAfterSecs
          : DEFAULT_RETRY_AFTER_SECS
      const waitMs = Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, safeSecs * 1000))
      console.warn(
        `[retry:${ctx}] 429 (attempt ${attempt + 1}/${maxRetries + 1}) sleeping ${waitMs}ms`,
      )
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw lastErr ?? new Error(`[retry:${ctx}] exhausted ${maxRetries} retries`)
}
