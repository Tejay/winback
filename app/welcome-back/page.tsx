import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const FAILURE_MESSAGES: Record<string, { emoji: string; title: string; body: string }> = {
  subscriber_not_found: {
    emoji: '🔗',
    title: 'This link is no longer valid',
    body: "It may have expired or been used already. If you'd like to resubscribe, please reach out to us directly.",
  },
  account_disconnected: {
    emoji: '⚙️',
    title: 'Reactivation is temporarily unavailable',
    body: "We're unable to process resubscriptions right now. Please contact us and we'll get you set up.",
  },
  price_unavailable: {
    emoji: '📋',
    title: "We've updated our plans",
    body: "The plan you were on isn't offered anymore. Drop us a line and we'll find one that fits.",
  },
  checkout_failed: {
    emoji: '⚠️',
    title: 'Something went wrong on our end',
    body: 'Please try again in a moment, or contact us if it keeps happening.',
  },
}

interface MerchantIdentity {
  productName: string
}

const MAX_NAME_LENGTH = 40

/**
 * Spec 36 — resolve merchant identity from the `customer` query param so
 * the page can render the merchant's brand (NOT Winback's). Returns
 * null when the param is missing, malformed, or doesn't resolve to a
 * row — caller falls through to a neutral state with no logo at all.
 *
 * UUID validity is checked up-front because Postgres throws on a bad
 * cast, which would 500 the page. We treat invalid UUIDs the same as
 * missing — neutral state.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveMerchantIdentity(
  customerId: string | undefined,
): Promise<MerchantIdentity | null> {
  if (!customerId || !UUID_RE.test(customerId)) return null

  try {
    const [row] = await db
      .select({
        productName: customers.productName,
        founderName: customers.founderName,
      })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1)

    if (!row) return null

    const raw = row.productName ?? row.founderName ?? ''
    if (!raw.trim()) return null

    const truncated = raw.length > MAX_NAME_LENGTH
      ? raw.slice(0, MAX_NAME_LENGTH - 1).trimEnd() + '…'
      : raw

    return { productName: truncated }
  } catch (err) {
    console.warn('[welcome-back] merchant lookup failed:', err)
    return null
  }
}

export default async function WelcomeBackPage({
  searchParams,
}: {
  searchParams: Promise<{ recovered?: string; reason?: string; customer?: string }>
}) {
  const { recovered, reason, customer } = await searchParams
  const isRecovered = recovered === 'true'

  // If a failure reason is supplied and we recognise it, show the contextual
  // message. Otherwise fall back to the generic "no worries" copy.
  const failure = !isRecovered && reason ? FAILURE_MESSAGES[reason] : null

  const merchant = await resolveMerchantIdentity(customer)

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center justify-center">
      {merchant ? (
        <div className="mb-8 text-2xl font-semibold text-slate-900 tracking-tight">
          {merchant.productName}
        </div>
      ) : (
        // Spec 36 — direct nav, malformed customer id, or unknown merchant.
        // Show a blank space rather than the Winback logo. End customers
        // shouldn't see Winback branding from this page; merchants who
        // want a logo can fix it via the `customer` query param.
        <div className="mb-8" aria-hidden />
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 max-w-sm text-center">
        {isRecovered ? (
          <>
            <div className="text-4xl mb-4">🎉</div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">
              Welcome back!
            </h1>
            <p className="text-sm text-slate-500">
              Thanks for giving us another try. Your subscription is active again.
            </p>
          </>
        ) : failure ? (
          <>
            <div className="text-4xl mb-4">{failure.emoji}</div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">
              {failure.title}
            </h1>
            <p className="text-sm text-slate-500">
              {failure.body}
            </p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-4">👋</div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">
              No worries.
            </h1>
            <p className="text-sm text-slate-500">
              You can come back anytime. We&apos;ll keep improving.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
