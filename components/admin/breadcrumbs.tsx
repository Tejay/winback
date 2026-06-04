'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * Auto-breadcrumbs derived from the URL path. Renders above page content
 * in the admin layout. Static label map keys off path segments so pages
 * don't need to opt-in for v1.
 *
 *   /admin                         → Admin
 *   /admin/customers               → Admin / Customers
 *   /admin/customers/abc-uuid      → Admin / Customers / Customer
 *   /admin/subscribers/abc-uuid    → Admin / Subscribers / Subscriber
 *
 * Pages that need richer crumbs (showing the actual customer email
 * instead of the literal "Customer") can render their own breadcrumb
 * component later — this is the no-per-page-work default.
 */
const SEGMENT_LABELS: Record<string, string> = {
  customers:   'Customers',
  subscribers: 'Subscribers',
  pilots:      'Pilots',
  'ai-quality': 'AI quality',
  insights:    'Insights',
  billing:     'Billing',
  events:      'Events',
  'audit-log': 'Audit log',
}

interface Crumb {
  label: string
  href: string | null
}

function buildCrumbs(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return []

  const crumbs: Crumb[] = []
  let acc = ''
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    acc += `/${seg}`
    if (i === 0 && seg === 'admin') {
      crumbs.push({ label: 'Admin', href: '/admin' })
      continue
    }
    const known = SEGMENT_LABELS[seg]
    if (known) {
      crumbs.push({ label: known, href: acc })
      continue
    }
    // Dynamic segment (id / uuid) — derive label from the parent
    const parent = segments[i - 1]
    const label = parent === 'customers'   ? 'Customer'
                : parent === 'subscribers' ? 'Subscriber'
                : seg.slice(0, 8)
    crumbs.push({ label, href: acc })
  }

  // Last crumb is the current page — strip its href so it renders as plain text
  const last = crumbs[crumbs.length - 1]
  crumbs[crumbs.length - 1] = { label: last.label, href: null }
  return crumbs
}

export function Breadcrumbs() {
  const pathname = usePathname()
  const crumbs = buildCrumbs(pathname)
  if (crumbs.length === 0) return null

  return (
    <nav aria-label="Breadcrumbs" className="text-xs text-slate-500 flex items-center gap-1.5 flex-wrap">
      {crumbs.map((c, i) => (
        <span key={`${c.label}-${i}`} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-slate-300" aria-hidden>/</span>}
          {c.href
            ? <Link href={c.href} className="hover:text-slate-700">{c.label}</Link>
            : <span className="text-slate-700 font-medium" aria-current="page">{c.label}</span>}
        </span>
      ))}
    </nav>
  )
}
