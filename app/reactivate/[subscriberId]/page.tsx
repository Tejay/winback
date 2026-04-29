import { notFound, redirect } from 'next/navigation'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { verifySubscriberToken } from '@/src/winback/lib/unsubscribe-token'
import { ChooserForm } from './chooser-form'

/**
 * Spec 20c — tier chooser page.
 *
 * Shown when the reactivate route detects multiple active prices on the
 * connected account, OR the subscriber's saved price is no longer active.
 * Token-protected (signed by /api/reactivate route).
 */

interface PriceOption {
  id: string
  productName: string
  unitAmount: number | null
  currency: string
  interval: string | null
  isPrevious: boolean
}

export default async function ReactivateChooserPage({
  params,
  searchParams,
}: {
  params: Promise<{ subscriberId: string }>
  searchParams: Promise<{ t?: string }>
}) {
  const { subscriberId } = await params
  const { t } = await searchParams

  if (!verifySubscriberToken(subscriberId, 'reactivate', t)) {
    notFound()
  }

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) notFound()

  // Spec 36 — pass winback customer id on /welcome-back redirects so
  // the page renders the merchant's brand (not Winback's).
  const customerParam = `&customer=${subscriber.customerId}`

  // Already recovered — bounce to welcome
  if (subscriber.status === 'recovered') {
    redirect(`/welcome-back?recovered=true${customerParam}`)
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, subscriber.customerId))
    .limit(1)

  if (!customer?.stripeAccessToken) {
    redirect(`/welcome-back?recovered=false&reason=account_disconnected${customerParam}`)
  }

  // Load active prices + their products (for display names)
  const stripe = new Stripe(decrypt(customer.stripeAccessToken))
  const pricesList = await stripe.prices.list({
    active: true,
    type: 'recurring',
    limit: 10,
    expand: ['data.product'],
  })

  if (pricesList.data.length === 0) {
    redirect(`/welcome-back?recovered=false&reason=price_unavailable${customerParam}`)
  }

  const options: PriceOption[] = pricesList.data.map(p => {
    const product = p.product as Stripe.Product
    return {
      id: p.id,
      productName: product?.name ?? 'Plan',
      unitAmount: p.unit_amount,
      currency: p.currency,
      interval: p.recurring?.interval ?? null,
      isPrevious: p.id === subscriber.stripePriceId,
    }
  })

  // Sort: previous plan first, then by price ascending
  options.sort((a, b) => {
    if (a.isPrevious !== b.isPrevious) return a.isPrevious ? -1 : 1
    return (a.unitAmount ?? 0) - (b.unitAmount ?? 0)
  })

  const firstName = subscriber.name?.split(' ')[0] ?? 'there'

  // Spec 36 — render the merchant's brand (NOT Winback's). Same pattern
  // as /welcome-back: customer is already loaded above; pull a wordmark
  // from product_name → founder_name. If both are missing, render
  // nothing (blank space) — never the Winback logo.
  const rawMerchantName = customer.productName ?? customer.founderName ?? ''
  const merchantWordmark = rawMerchantName.trim().length > 0
    ? (rawMerchantName.length > 40
        ? rawMerchantName.slice(0, 39).trimEnd() + '…'
        : rawMerchantName)
    : null

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center py-12 px-4">
      {merchantWordmark ? (
        <div className="mb-8 text-2xl font-semibold text-slate-900 tracking-tight">
          {merchantWordmark}
        </div>
      ) : (
        <div className="mb-8" aria-hidden />
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-slate-900 mb-2">
          Welcome back, {firstName}.
        </h1>
        <p className="text-sm text-slate-600 mb-6">
          Pick a plan to resubscribe.
        </p>

        <ChooserForm subscriberId={subscriberId} token={t!} options={options} />

        <div className="mt-6 text-center">
          <a
            href={`/welcome-back?recovered=false${customerParam}`}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Not now, take me back
          </a>
        </div>
      </div>
    </div>
  )
}
