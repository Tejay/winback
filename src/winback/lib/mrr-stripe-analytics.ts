/**
 * Stripe Analytics API — second-opinion MRR source.
 *
 * Calls POST /v2/data/analytics/metric_query with metric `revenue.mrr` for
 * a window ending now, with the platform's secret key plus a Stripe-Account
 * header pointing at the connected merchant account. Returns Stripe's
 * reported MRR in USD minor units, or null on any failure (preview API,
 * Connect-incompatible, network error, anything).
 *
 * Used ONLY as a reconciliation signal — our own computeMrrFromStripe is
 * always the source of truth. The presence of a non-null figure here just
 * means we can display "Stripe's reported MRR: $X ✓" in the activation UI
 * for extra dispute armor.
 *
 * Why fetch() and not the Stripe SDK: the endpoint is preview-versioned
 * (2026-04-22.preview), v2-namespaced, and the official SDK may not have
 * typed bindings. We want fine-grained control over the failure path so we
 * can swallow everything and return null without disturbing the snapshot.
 */

const ENDPOINT = 'https://api.stripe.com/v2/data/analytics/metric_query'
const STRIPE_VERSION = '2026-04-22.preview'

type AnalyticsResponse = {
  data?: Array<{
    results?: Array<{
      name?: string
      currency?: string
      value?: number
    }>
  }>
}

/**
 * Fetches Stripe's reported MRR for `connectedAccountId` in USD minor units.
 * Returns null on any failure — including HTTP non-2xx, network errors,
 * unexpected response shape, missing secret key, etc. Never throws.
 *
 * Window: trailing 24 hours ending now (single granularity bucket).
 * That's the smallest stable window for `revenue.mrr` and avoids needing
 * to align to UTC day boundaries.
 */
export async function fetchStripeReportedMrr(
  connectedAccountId: string,
): Promise<number | null> {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) return null

  const now = new Date()
  const startsAt = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const body = {
    metrics: [{ name: 'revenue.mrr' }],
    starts_at: startsAt.toISOString(),
    ends_at: now.toISOString(),
    granularity: 'day',
    currency: 'usd',
  }

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
        'Stripe-Version': STRIPE_VERSION,
        'Stripe-Account': connectedAccountId,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch (err) {
    console.warn('[mrr-stripe-analytics] fetch failed', {
      connectedAccountId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  if (!res.ok) {
    // 404 / 403 here is the "this account doesn't support the API yet"
    // signal — return null silently. Don't spam logs on every snapshot.
    if (res.status === 404 || res.status === 403) return null
    console.warn('[mrr-stripe-analytics] non-2xx', {
      connectedAccountId,
      status: res.status,
    })
    return null
  }

  let payload: AnalyticsResponse
  try {
    payload = await res.json() as AnalyticsResponse
  } catch {
    return null
  }

  // Find the most recent bucket with a usable MRR value. Bucket order
  // isn't strictly guaranteed in our trailing-24h query (single bucket
  // expected), so be defensive.
  for (const bucket of payload.data ?? []) {
    for (const result of bucket.results ?? []) {
      if (result.name === 'revenue.mrr' && typeof result.value === 'number') {
        return Math.round(result.value)
      }
    }
  }
  return null
}
