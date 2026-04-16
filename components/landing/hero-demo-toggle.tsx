'use client'

import { useState } from 'react'
import Image from 'next/image'
import { FlowIllustration } from './flow-illustration'

/**
 * Temporary A/B toggle for comparing hero visual options.
 * Remove after choosing — keep only the winner.
 */
export function HeroDemoToggle() {
  const [option, setOption] = useState<'A' | 'B'>('A')

  return (
    <div className="w-full max-w-4xl mx-auto mt-12">
      {/* Toggle — remove after choosing */}
      <div className="flex justify-center gap-2 mb-6">
        <button
          onClick={() => setOption('A')}
          className={`px-4 py-1.5 rounded-full text-xs font-medium border transition ${
            option === 'A'
              ? 'bg-[#0f172a] text-white border-[#0f172a]'
              : 'bg-white text-slate-600 border-slate-200'
          }`}
        >
          A — Screenshot only
        </button>
        <button
          onClick={() => setOption('B')}
          className={`px-4 py-1.5 rounded-full text-xs font-medium border transition ${
            option === 'B'
              ? 'bg-[#0f172a] text-white border-[#0f172a]'
              : 'bg-white text-slate-600 border-slate-200'
          }`}
        >
          B — Flow + Screenshot
        </button>
      </div>

      {/* Option A: Screenshot only */}
      {option === 'A' && (
        <div className="rounded-2xl overflow-hidden shadow-lg border border-slate-200/60">
          <Image
            src="/demo-dashboard.png"
            alt="Winback dashboard showing recovered subscribers, recovery rate, and MRR recovered"
            width={1200}
            height={750}
            className="w-full h-auto"
            priority
          />
        </div>
      )}

      {/* Option B: Flow illustration + Screenshot below */}
      {option === 'B' && (
        <>
          <FlowIllustration />
          <div className="mt-8 rounded-2xl overflow-hidden shadow-lg border border-slate-200/60">
            <Image
              src="/demo-dashboard.png"
              alt="Winback dashboard showing recovered subscribers, recovery rate, and MRR recovered"
              width={1200}
              height={750}
              className="w-full h-auto"
              priority
            />
          </div>
        </>
      )}
    </div>
  )
}
