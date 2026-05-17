'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Logo } from '@/components/logo'

/**
 * Sticky top nav for the marketing landing page. Gains a hairline border +
 * soft shadow once the user has scrolled past the very top so the edge
 * between nav and hero stays crisp without fighting the hero on first paint.
 *
 * Client component purely because we need a scroll listener. No other state.
 *
 * Nav structure (Option A — standard SaaS pattern, founder-approved):
 *
 *   [logo winback]   Payment recovery · Winback · Pricing · Questions
 *                                                          |  Log in · [Sign up →]
 *
 * Choices made:
 * - "Home" link dropped — the logo IS the home link, no need to duplicate
 * - "FAQ" -> "Questions" — plain English, pairs with /pricing copy "The
 *   four questions buyers ask." Route stays /faq (URL is canonical).
 * - "Winback" (no hyphen) — matches the wordmark. Route stays /win-back.
 * - Vertical divider before the auth zone so "Log in" and "Sign up" read
 *   as a paired auth cluster, distinct from the product/info links.
 * - "Start recovering →" -> "Sign up →" — clearer call-to-action label.
 *   Same destination (/register). Returning users get "Log in" explicitly
 *   instead of having to know that "Log in" alone covered both.
 */
export function StickyNav() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <nav
      className={`sticky top-0 z-40 bg-white/90 backdrop-blur transition-shadow ${
        scrolled ? 'border-b border-slate-200 shadow-sm' : 'border-b border-transparent'
      }`}
    >
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <Logo />
        <div className="flex items-center gap-6">
          {/* Product + info links */}
          <Link
            href="/payment-recovery"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            Payment recovery
          </Link>
          <Link
            href="/win-back"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            Winback
          </Link>
          <Link
            href="/pricing"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            Pricing
          </Link>
          <Link
            href="/faq"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            Questions
          </Link>

          {/* Auth zone — visually separated from product links by a hairline
              divider so new users immediately see "Log in vs. Sign up" as
              a distinct pair. Divider hidden on mobile where product links
              already collapse. */}
          <span
            aria-hidden
            className="hidden sm:inline-block w-px h-5 bg-slate-200"
          />
          <Link
            href="/login"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            Log in
          </Link>
          <Link
            href="/register"
            className="bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-[#1e293b]"
          >
            Sign up &rarr;
          </Link>
        </div>
      </div>
    </nav>
  )
}
