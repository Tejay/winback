'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { CancellationThemes, type ThemeView } from './cancellation-themes'
import { ReasonsClient } from './reasons-client'
import { PromotionsSection, type PromotionView } from './promotions-section'

/**
 * /reasons — two tabs, one per win-back lever:
 *
 *   • Features (default) — the demand → supply loop, side by side:
 *       LEFT  "What they asked for"  = AI-clustered cancellation themes
 *       RIGHT "What you've shipped"  = the merchant's published reasons
 *     "+ Add as reason" on a theme hands off to the reasons editor in the
 *     same tab (the two former "Suggested" + "Active" tabs, merged so the
 *     demand→supply relationship is visible without tab-hopping).
 *   • Discount — the price-canceller fallback: a Stripe-native promo with
 *     an off / manual / auto switch.
 *
 * Tab state lives in the URL (?tab=features|discount) so deep-links +
 * browser-back work and the "+ Add as reason" hand-off can drive the tab
 * via navigation (?tab=features&prefill_title=...). Legacy values
 * (suggested/active → features, promotions → discount) still resolve so
 * old links don't 404.
 *
 * Both panes are always mounted; we toggle `hidden` so soft-navs don't
 * unmount/remount the heavy ReasonsClient + its modal state on every tab
 * switch. Mount cost up-front; switches are instant.
 */

type TabKey = 'features' | 'discount'

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

// Resolve the URL tab param to one of the two tabs. Legacy three-tab
// values are mapped forward so existing links/bookmarks still land.
function resolveTab(v: string | null): TabKey {
  if (v === 'discount' || v === 'promotions') return 'discount'
  return 'features' // 'features' | 'suggested' | 'active' | null | invalid
}

function TabButton({
  active,
  color = 'blue',
  onClick,
  children,
}: {
  active: boolean
  color?: 'blue' | 'emerald'
  onClick: () => void
  children: React.ReactNode
}) {
  const activeBg = color === 'emerald' ? 'bg-emerald-600' : 'bg-blue-600'
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? `flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold ${activeBg} text-white shadow-sm border border-transparent transition-colors`
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
  const tab: TabKey = resolveTab(sp.get('tab'))

  function setTab(next: TabKey) {
    // Preserve any prefill_* params so the theme → editor hand-off
    // (which lands with tab=features AND prefill_title set) keeps the
    // prefill alive across a manual click. ReasonsClient clears prefill
    // itself once it reads them.
    const params = new URLSearchParams(sp.toString())
    params.set('tab', next)
    router.push(`/reasons?${params.toString()}`, { scroll: false })
  }

  // Features carries the "new demand" attention badge: count of clustered
  // themes the merchant hasn't shipped yet (red, like the old Suggested tab).
  const featuresBadge = counts.suggested > 0
    ? (
      <span className={`inline-flex items-center justify-center text-[10px] font-semibold rounded-full w-4 h-4 ${
        tab === 'features' ? 'bg-white/20 text-white' : 'bg-red-500 text-white'
      }`}>
        {counts.suggested}
      </span>
    )
    : null

  // Discount carries an on/off state badge.
  const discountBadge = counts.promoOn
    ? (
      <span className={`inline-flex items-center gap-1 text-xs font-normal ${tab === 'discount' ? 'text-emerald-100' : 'text-emerald-600'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${tab === 'discount' ? 'bg-emerald-200' : 'bg-emerald-500'}`}></span>
        on
      </span>
    )
    : <span className={`text-xs font-normal ${tab === 'discount' ? 'opacity-80' : 'text-slate-400'}`}>off</span>

  return (
    <>
      {/* Two tabs — one per win-back lever */}
      <div className="flex items-center gap-3 mb-6">
        <TabButton active={tab === 'features'} color="blue" onClick={() => setTab('features')}>
          Features
          {featuresBadge}
        </TabButton>
        <TabButton active={tab === 'discount'} color="emerald" onClick={() => setTab('discount')}>
          Discount
          {discountBadge}
        </TabButton>
      </div>

      {/* Features pane — demand (themes) → supply (reasons), side by side.
          Both former tabs live here so the loop is visible at a glance. */}
      <div className={tab === 'features' ? '' : 'hidden'}>
        <p className="text-sm text-slate-500 mb-4">
          Cancelled customers tell us why they left. Ship the fix, mark it here, and we email everyone who asked.
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] gap-4 items-start">
          {/* Demand */}
          <div>
            <CancellationThemes {...suggestedProps} />
          </div>

          {/* Connector — decorative; hidden on mobile (columns stack). */}
          <div className="hidden lg:flex lg:flex-col items-center justify-center self-center px-1 text-slate-300">
            <span className="text-2xl leading-none" aria-hidden>&rarr;</span>
            <span className="text-[10px] uppercase tracking-widest text-slate-400 mt-1 [writing-mode:vertical-rl] rotate-180">ship it</span>
          </div>

          {/* Supply — guidance strip + the reasons editor (full functionality) */}
          <div className="space-y-4">
            <GuidanceStrip />
            <ReasonsClient {...activeProps} />
          </div>
        </div>
      </div>

      {/* Discount pane — the price-canceller fallback */}
      <div className={tab === 'discount' ? '' : 'hidden'}>
        <p className="text-sm text-slate-500 mb-4">
          When someone cancels purely on price, no feature will bring them back — offer a discount to price-sensitive cancellers instead.
        </p>
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
