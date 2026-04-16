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
          <a
            href="#how-it-works"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            Product
          </a>
          <a
            href="#pricing"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            Pricing
          </a>
          <Link
            href="/faq"
            className="hidden sm:inline text-slate-600 text-sm hover:text-slate-900"
          >
            FAQ
          </Link>
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
            Start recovering →
          </Link>
        </div>
      </div>
    </nav>
  )
}
