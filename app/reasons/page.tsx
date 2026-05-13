import { redirect } from 'next/navigation'
import { auth, userIsAdmin } from '@/lib/auth'

// Defensive — `dateShipped` is a Postgres DATE (Drizzle returns YYYY-MM-DD
// string), but if anything else creeps in (Date, null, undefined) we still
// produce a valid YYYY-MM-DD string instead of crashing the page render.
function toIsoDate(v: unknown): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

function toIsoDateTime(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString()
  if (typeof v === 'string') return v
  return new Date().toISOString()
}

import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { ReasonsClient } from './reasons-client'

/**
 * Spec 65 Phase 2 — Winback Reasons page.
 *
 * Server shell. Auth check, fetch the customer's improvements, hand off
 * to ReasonsClient for interactivity.
 */
export default async function ReasonsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const isAdmin = await userIsAdmin(session.user.id)

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) redirect('/onboarding/stripe')
  if (!customer.stripeAccessToken) redirect('/onboarding/stripe')

  const rows = await db
    .select()
    .from(improvements)
    .where(eq(improvements.customerId, customer.id))
    .orderBy(desc(improvements.dateShipped))

  return (
    <>
      <TopNav userName={session.user.name} isAdmin={isAdmin} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Winback</p>
          <h1 className="text-4xl font-bold mt-1 text-slate-900">Winback reasons.</h1>
          <p className="text-sm text-slate-500 mt-3 max-w-2xl">
            This is how cancelled customers learn you fixed what they wanted.
            Add a short, specific line per shipped improvement. We do the matching
            and emailing. Up to <strong>10 active improvements</strong> at a time.
          </p>

          <details className="mt-4 max-w-2xl rounded-2xl border border-slate-200 bg-white group">
            <summary className="cursor-pointer list-none px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 flex items-center justify-between rounded-2xl">
              <span>Best practices</span>
              <span className="text-slate-400 text-xs group-open:rotate-180 transition-transform">▾</span>
            </summary>
            <div className="px-5 pb-5 pt-1 text-sm text-slate-600 space-y-4">
              <div>
                <p className="font-medium text-slate-900">When should I add an improvement?</p>
                <p className="mt-1">Every time you ship something a cancelled customer might have wanted. There&apos;s no minimum cadence. Most merchants add one every few weeks to a couple of months.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">What makes a good entry?</p>
                <p className="mt-1">Concrete and specific. &quot;Shipped Slack integration with channel routing&quot; is good. &quot;We made improvements to notifications&quot; won&apos;t match anyone.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">What gets sent to customers?</p>
                <p className="mt-1">One personalised email per customer, only when our AI is confident the improvement addresses something they explicitly said when they cancelled.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">Can I edit or remove improvements?</p>
                <p className="mt-1">Edit or remove anytime. Add when you have real improvements you want to share with cancelled customers.</p>
              </div>
              <div>
                <p className="font-medium text-slate-900">Examples</p>
                <ul className="mt-1 space-y-1">
                  <li><span className="text-green-700">✓</span> Shipped Slack integration with channel routing</li>
                  <li><span className="text-green-700">✓</span> Bulk CSV import — up to 100K rows</li>
                  <li><span className="text-red-600">✗</span> We made improvements to imports</li>
                  <li><span className="text-red-600">✗</span> Big things are coming!</li>
                </ul>
              </div>
            </div>
          </details>

          <div className="mt-8">
            <ReasonsClient initialImprovements={rows.map((r) => ({
              id:               r.id,
              title:            r.title,
              description:      r.description,
              dateShipped:      toIsoDate(r.dateShipped),
              status:           r.status as 'published' | 'archived',
              addressesPattern: r.addressesPattern ?? null,
              preempted:        r.preempted,
              createdAt:        toIsoDateTime(r.createdAt),
            }))} />
          </div>
        </div>
      </main>
    </>
  )
}
