import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { StepProgress } from '@/components/step-progress'
import { Mail } from 'lucide-react'
import Link from 'next/link'

export default async function OnboardingGmailPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  const stripeConnected = !!customer?.stripeAccountId
  const gmailConnected = !!customer?.gmailRefreshToken
  const completedSteps: number[] = []
  if (stripeConnected) completedSteps.push(1)
  if (gmailConnected) completedSteps.push(2)

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="px-6 py-5">
        <Logo size="sm" />
      </div>

      <div className="max-w-2xl mx-auto px-4 pb-12">
        <StepProgress currentStep={2} completedSteps={completedSteps} />

        <div className="mt-6 bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          <span className="bg-blue-50 text-blue-700 text-xs font-semibold rounded-full px-3 py-1 inline-block mb-4">
            STEP 2 OF 4
          </span>

          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Connect Gmail to send winback emails
          </h1>
          <p className="text-sm text-slate-500 mb-6">
            Emails go from your real address, not a generic no-reply.
            That&apos;s what gets replies.
          </p>

          <div className="bg-slate-50 rounded-xl border border-slate-100 p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="bg-red-50 rounded-xl w-10 h-10 flex items-center justify-center">
                <Mail className="w-5 h-5 text-[#EA4335]" />
              </div>
              <div>
                <div className="text-sm font-medium text-slate-900">Gmail</div>
                <div className="text-xs text-slate-500">
                  Send from your own address via OAuth
                </div>
              </div>
            </div>
            <a
              href="/api/gmail/connect"
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
            >
              Connect Gmail
            </a>
          </div>

          <div className="mt-4 space-y-3">
            {[
              'Send only — we never read your inbox',
              'Replies land directly in your real inbox',
              'Revoke access in Google anytime',
            ].map((text) => (
              <div key={text} className="flex items-center gap-2 text-sm text-slate-500">
                <span className="text-blue-600 font-bold text-base">✓</span>
                {text}
              </div>
            ))}
          </div>

          <div className="flex justify-between mt-8">
            <Link
              href="/onboarding/stripe"
              className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
            >
              Back
            </Link>
            <Link
              href={gmailConnected ? '/onboarding/changelog' : '#'}
              className={`rounded-full px-5 py-2 text-sm font-medium ${
                gmailConnected
                  ? 'bg-[#0f172a] text-white hover:bg-[#1e293b]'
                  : 'bg-slate-200 text-slate-400 cursor-not-allowed'
              }`}
              aria-disabled={!gmailConnected}
            >
              Next: Paste changelog &rarr;
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
