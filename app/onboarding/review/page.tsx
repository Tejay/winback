import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { StepProgress } from '@/components/step-progress'
import { ApproveButton } from './approve-button'
import Link from 'next/link'

export default async function OnboardingReviewPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  const gmailEmail = customer?.gmailEmail ?? 'you@yourdomain.com'
  const userName = session.user.name ?? gmailEmail.split('@')[0]
  const changelog = customer?.changelogText

  const emailBody = `Hi Sarah,

You cancelled our app last week and mentioned small issues kept getting in the way. That feedback stuck with us.

Here's what's changed since you left:

${changelog ? changelog : '- (your recent improvements will appear here)'}

It's a much more reliable experience now. If you're open to it, I'd love for you to take another look — no pressure, no trial reset.

— ${userName}`

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="px-6 py-5">
        <Logo size="sm" />
      </div>

      <div className="max-w-2xl mx-auto px-4 pb-12">
        <StepProgress currentStep={4} completedSteps={[1, 2, 3]} />

        <div className="mt-6 bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          <span className="bg-blue-50 text-blue-700 text-xs font-semibold rounded-full px-3 py-1 inline-block mb-4">
            STEP 4 OF 4
          </span>

          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Review the first winback email
          </h1>
          <p className="text-sm text-slate-500 mb-6">
            This is what a real churned customer will receive, personalised to
            their cancellation reason.
          </p>

          <div className="border border-slate-200 rounded-2xl overflow-hidden mt-6">
            <div className="flex justify-between items-center px-5 py-3 border-b border-slate-100 text-sm">
              <span className="text-slate-400">From</span>
              <span className="text-slate-900">{gmailEmail}</span>
            </div>
            <div className="flex justify-between items-center px-5 py-3 border-b border-slate-100 text-sm">
              <span className="text-slate-400">To</span>
              <span className="text-slate-900">sarah.k@gmail.com</span>
            </div>
            <div className="flex justify-between items-center px-5 py-3 border-b border-slate-100 text-sm">
              <span className="text-slate-400">Subject</span>
              <span className="text-slate-900">A quick update since you left</span>
            </div>
            <div className="p-6 text-sm text-slate-700 leading-relaxed whitespace-pre-line">
              {emailBody}
            </div>
          </div>

          <div className="bg-blue-50 rounded-xl p-4 mt-4">
            <div className="text-sm font-semibold text-blue-700 mb-1">
              Why this message?
            </div>
            <div className="text-sm text-blue-600">
              Sarah left over quality issues &mdash; so we lead with
              accountability and show what changed. No discount, no pressure.
            </div>
          </div>

          <div className="flex justify-between mt-8">
            <Link
              href="/onboarding/changelog"
              className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
            >
              Back
            </Link>
            <ApproveButton />
          </div>
        </div>

        <p className="text-xs text-slate-400 text-center mt-4">
          Your first recovery is free. After that: &pound;49/mo + 10% of
          recovered MRR for the first year each subscriber stays back.
        </p>
      </div>
    </div>
  )
}
