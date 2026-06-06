'use client'

import Link from 'next/link'
import { track } from './track'

/**
 * A primary marketing CTA that records an anonymous `cta_clicked` event
 * (with its `location`) before navigating. Drop-in replacement for the
 * `next/link` used on the public landing/pricing pages — same `href` +
 * `className` + children; just add a `location`.
 *
 * The beacon fires on click and survives the navigation (sendBeacon), so we
 * don't preventDefault — the link follows through normally.
 */
export function TrackedCta({
  href,
  location,
  className,
  children,
}: {
  href: string
  location: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={className}
      onClick={() => track('cta_clicked', location)}
    >
      {children}
    </Link>
  )
}
