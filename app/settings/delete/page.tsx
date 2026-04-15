import Link from 'next/link'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { slugifyWorkspaceName } from '@/src/winback/lib/workspace'
import { DeleteConfirmation } from './delete-confirmation'

export const metadata = { title: 'Delete workspace — Winback' }

export default async function DeleteWorkspacePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select({
      id: customers.id,
      productName: customers.productName,
      stripeAccessToken: customers.stripeAccessToken,
      gmailRefreshToken: customers.gmailRefreshToken,
      pausedAt: customers.pausedAt,
    })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  const email = session.user.email ?? ''
  const workspaceName = slugifyWorkspaceName(customer?.productName, email)

  let subscribersCount = 0
  let recoveriesCount = 0
  let recoveredCents = 0

  if (customer) {
    const [subRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(churnedSubscribers)
      .where(eq(churnedSubscribers.customerId, customer.id))
    subscribersCount = subRow?.n ?? 0

    const [recRow] = await db
      .select({
        n: sql<number>`count(*)::int`,
        sum: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::int`,
      })
      .from(recoveries)
      .where(eq(recoveries.customerId, customer.id))
    recoveriesCount = recRow?.n ?? 0
    recoveredCents = recRow?.sum ?? 0
  }

  const pounds = (cents: number) =>
    `£${(cents / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`

  return (
    <main className="min-h-screen bg-[#f5f5f5] py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          &larr; Back to Settings
        </Link>

        <div className="mt-6 bg-white border border-rose-200 rounded-2xl shadow-sm p-8">
          <div className="text-xs font-semibold tracking-widest uppercase text-rose-600">
            Danger zone
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mt-2">
            Before you delete your workspace
          </h1>
          <p className="text-sm text-slate-500 mt-2">
            This will permanently:
          </p>

          <ul className="mt-5 space-y-2.5 text-sm text-slate-700">
            {customer?.stripeAccessToken && (
              <li className="flex items-start gap-2.5">
                <span className="text-rose-500 font-bold">&times;</span>
                <span>Disconnect your Stripe account</span>
              </li>
            )}
            {customer?.gmailRefreshToken && (
              <li className="flex items-start gap-2.5">
                <span className="text-rose-500 font-bold">&times;</span>
                <span>Disconnect your Gmail account</span>
              </li>
            )}
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>
                Delete{' '}
                <strong className="text-slate-900">{subscribersCount.toLocaleString()}</strong>{' '}
                churned subscriber record{subscribersCount === 1 ? '' : 's'}
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>
                Delete{' '}
                <strong className="text-slate-900">{recoveriesCount.toLocaleString()}</strong>{' '}
                recovery record{recoveriesCount === 1 ? '' : 's'} worth{' '}
                <strong className="text-slate-900">{pounds(recoveredCents)}</strong>{' '}
                recovered
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>Cancel your billing immediately</span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>Remove all email sequences in progress</span>
            </li>
          </ul>

          <p className="mt-6 text-sm text-slate-900 font-medium">
            This cannot be undone. There is no grace period.
          </p>

          {!customer?.pausedAt && (
            <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
              <strong className="font-semibold">Not ready to delete?</strong>{' '}
              You can{' '}
              <Link href="/settings" className="underline hover:text-amber-950">
                pause all emails instead
              </Link>{' '}
              — your data stays intact and you can reactivate anytime.
            </div>
          )}

          <DeleteConfirmation workspaceName={workspaceName} />
        </div>
      </div>
    </main>
  )
}
