'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Logo } from '@/components/logo'
import { StepProgress } from '@/components/step-progress'

export default function OnboardingChangelogPage() {
  const router = useRouter()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleNext() {
    setLoading(true)
    if (content.trim()) {
      await fetch('/api/changelog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
    }
    router.push('/onboarding/review')
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="px-6 py-5">
        <Logo size="sm" />
      </div>

      <div className="max-w-2xl mx-auto px-4 pb-12">
        <StepProgress currentStep={3} completedSteps={[1, 2]} />

        <div className="mt-6 bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
          <span className="bg-blue-50 text-blue-700 text-xs font-semibold rounded-full px-3 py-1 inline-block mb-4">
            STEP 3 OF 4
          </span>

          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            What have you shipped recently?
          </h1>
          <p className="text-sm text-slate-500 mb-6">
            Paste a list of improvements. Winback uses this to write honest,
            specific winback messages &mdash; not generic discounts.
          </p>

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={`e.g.\n- Fixed the calendar sync bug that was duplicating events\n- Rebuilt the mobile app from scratch — 3x faster\n- Added CSV export for all reports\n- New billing dashboard with usage breakdown\n- Removed the 30-second load time on the projects page`}
            className="min-h-[200px] w-full border border-slate-200 rounded-2xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />

          <p className="text-xs text-slate-400 mt-2 flex items-center gap-1.5">
            ⚡ Bullet points work best. You can edit this any time in Settings.
          </p>

          <div className="flex justify-between mt-8">
            <Link
              href="/onboarding/gmail"
              className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
            >
              Back
            </Link>
            <button
              onClick={handleNext}
              disabled={loading}
              className={`rounded-full px-5 py-2 text-sm font-medium ${
                loading
                  ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                  : 'bg-[#0f172a] text-white hover:bg-[#1e293b]'
              }`}
            >
              {loading ? 'Saving...' : 'Next: Review first email →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
