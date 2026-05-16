'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { CancellationThemes, type ThemeView } from './cancellation-themes'
import { ReasonsClient } from './reasons-client'
import { PromotionsSection, type PromotionView } from './promotions-section'

/**
 * Spec 79 follow-up — /reasons restructured into three pill-button tabs:
 *
 *   • Suggested (default landing) — AI-clustered cancellation themes +
 *     post-ship insights. The "demand" surface; what to ship next.
 *   • Active — the merchant's published reasons list + always-visible
 *     guidance strip + "+ Add a reason". The "supply" surface.
 *   • Promotions — Stripe-native single-select promo + toggle for the
 *     price-canceler fallback path.
 *
 * Tab state lives in the URL (?tab=...) so deep-links + browser-back work
 * and the "+ Add as reason" hand-off from Suggested can drive the active
 * tab via navigation (?tab=active&prefill_title=...).
 *
 * All three panes are always mounted; we toggle `hidden` so soft-navs
 * don't unmount and remount the heavy ReasonsClient + its modal state
 * on every tab switch. Mount cost up-front; switches are instant.
 */

type TabKey = 'suggested' | 'active' | 'promotions'

interface Counts {
  suggested:  number   // theme rows (excluding post-ship insights)
  active:     number   // active reason rows
  promoOn:    boolean
  promoLabel: string | null   // e.g. "WINBACKE2E25" when one is selected
}

interface Props {
  suggestedProps:  React.ComponentProps<typeof CancellationThemes>
  activeProps:     React.ComponentProps<typeof ReasonsClient>
  promotionsProps: React.ComponentProps<typeof PromotionsSection>
  counts:          Counts
}

function isValidTab(v: string | null): v is TabKey {
  return v === 'suggested' || v === 'active' || v === 'promotions'
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold bg-blue-600 text-white shadow-sm border border-transparent transition-colors'
          : 'flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors'
      }
    >
      {children}
    </button>
  )
}

export function ReasonsTabs({ suggestedProps, activeProps, promotionsProps, counts }: Props) {
  const sp = useSearchParams()
  const router = useRouter()
  const tabParam = sp.get('tab')
  const tab: TabKey = isValidTab(tabParam) ? tabParam : 'suggested'

  function setTab(next: TabKey) {
    // Preserve any prefill_* params so the Suggested → Active hand-off
    // (which lands with both tab=active AND prefill_title set) keeps the
    // prefill alive across a manual click. ReasonsClient clears prefill
    // itself once it reads them.
    const params = new URLSearchParams(sp.toString())
    params.set('tab', next)
    router.push(`/reasons?${params.toString()}`, { scroll: false })
  }

  // Pretty count labels alongside each tab so the merchant doesn't need
  // to click in to see state.
  const suggestedBadge = counts.suggested > 0
    ? (
      <span className={`inline-flex items-center justify-center text-[10px] font-semibold rounded-full w-4 h-4 ${
        tab === 'suggested' ? 'bg-white/20 text-white' : 'bg-red-500 text-white'
      }`}>
        {counts.suggested}
      </span>
    )
    : null

  const activeBadge = counts.active > 0
    ? <span className={`text-xs font-normal ${tab === 'active' ? 'opacity-80' : 'text-slate-400'}`}>{counts.active}</span>
    : null

  const promoBadge = counts.promoOn
    ? (
      <span className={`inline-flex items-center gap-1 text-xs font-normal ${tab === 'promotions' ? 'text-emerald-100' : 'text-emerald-600'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${tab === 'promotions' ? 'bg-emerald-200' : 'bg-emerald-500'}`}></span>
        on
      </span>
    )
    : <span className={`text-xs font-normal ${tab === 'promotions' ? 'opacity-80' : 'text-slate-400'}`}>off</span>

  return (
    <>
      {/* Tab strip — pill buttons matching the dashboard cohort tabs */}
      <div className="flex items-center gap-3 mb-6">
        <TabButton active={tab === 'suggested'} onClick={() => setTab('suggested')}>
          Suggested
          {suggestedBadge}
        </TabButton>
        <TabButton active={tab === 'active'} onClick={() => setTab('active')}>
          Active
          {activeBadge}
        </TabButton>
        <TabButton active={tab === 'promotions'} onClick={() => setTab('promotions')}>
          Promotions
          {promoBadge}
        </TabButton>
      </div>

      {/* Suggested pane */}
      <div className={tab === 'suggested' ? '' : 'hidden'}>
        <CancellationThemes {...suggestedProps} />
      </div>

      {/* Active pane — always-visible guidance strip + the existing
          reasons editor + a one-liner footer (so "what gets sent?" is
          answered without clicking). The accordion that used to sit at
          the top of the page lives here now, dissolved into context. */}
      <div className={tab === 'active' ? '' : 'hidden'}>
        <div className="space-y-4">
          <GuidanceStrip />
          <ReasonsClient {...activeProps} />
        </div>
      </div>

      {/* Promotions pane */}
      <div className={tab === 'promotions' ? '' : 'hidden'}>
        <PromotionsSection {...promotionsProps} />
      </div>
    </>
  )
}

function GuidanceStrip() {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-2xl px-5 py-3 flex items-start gap-3 text-xs">
      <div className="text-slate-400 mt-0.5">ⓘ</div>
      <div className="flex-1 text-slate-600 leading-relaxed">
        <strong className="text-slate-700">What makes a good reason:</strong> concrete and specific.
        <span className="text-emerald-700 font-medium ml-2">✓ &ldquo;Shipped Slack integration with channel routing&rdquo;</span>
        <span className="text-emerald-700 font-medium ml-2">✓ &ldquo;Bulk CSV import — up to 100K rows&rdquo;</span>
        <span className="text-rose-600 font-medium ml-2">✗ &ldquo;We made improvements to imports&rdquo;</span>
        <span className="text-rose-600 font-medium ml-2">✗ &ldquo;Big things are coming!&rdquo;</span>
      </div>
    </div>
  )
}
