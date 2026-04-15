'use client'

import { useState } from 'react'

const RATE = 0.15
const MIN_MRR = 100
const MAX_MRR = 10000
const STEP = 50

function formatGBP(amount: number): string {
  return amount.toLocaleString('en-GB', { maximumFractionDigits: 0 })
}

export function PricingCalculator() {
  const [mrr, setMrr] = useState(500)
  const fee = Math.round(mrr * RATE)
  const keep = mrr - fee

  return (
    <div className="mt-16 max-w-2xl mx-auto text-left">
      {/* Split bar */}
      <div className="h-3 rounded-full overflow-hidden flex">
        <div className="bg-green-500" style={{ width: '85%' }} />
        <div className="bg-blue-500" style={{ width: '15%' }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
          You keep 85%
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
          We take 15%
        </span>
      </div>

      {/* Slider */}
      <div className="mt-10">
        <div className="flex items-baseline justify-between mb-3">
          <label htmlFor="mrr-slider" className="text-sm text-slate-600">
            See your numbers — how much could you recover?
          </label>
          <span className="text-sm font-semibold text-slate-900">
            £{formatGBP(mrr)}/mo
          </span>
        </div>
        <input
          id="mrr-slider"
          type="range"
          min={MIN_MRR}
          max={MAX_MRR}
          step={STEP}
          value={mrr}
          onChange={(e) => setMrr(Number(e.target.value))}
          className="w-full accent-blue-600"
        />
        <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
          <span>£{formatGBP(MIN_MRR)}</span>
          <span>£{formatGBP(MAX_MRR)}</span>
        </div>
      </div>

      {/* Stat cards */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-5">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Recovered revenue
          </div>
          <div className="mt-2 text-3xl font-semibold text-slate-900">
            £{formatGBP(mrr)}
          </div>
        </div>
        <div className="bg-slate-50 border border-slate-100 rounded-xl p-5">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Our fee (15%)
          </div>
          <div className="mt-2 text-3xl font-semibold text-blue-600">
            £{formatGBP(fee)}
          </div>
        </div>
        <div className="sm:col-span-2 bg-slate-50 border border-slate-100 rounded-xl p-5">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            You keep (85%)
          </div>
          <div className="mt-2 text-3xl font-semibold text-green-600">
            £{formatGBP(keep)}
          </div>
        </div>
      </div>
    </div>
  )
}
