'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Logo } from '@/components/logo'
import { CmdKTrigger } from './cmdk-trigger'
import { EnvBadge } from './env-badge'
import type { BuildInfo } from '@/lib/admin/build-info'

/**
 * Admin sidebar — PR 1.
 *
 * Replaces the topbar pills with a grouped left rail. Items map 1:1 to
 * existing pages; later PRs will reshape some (Events + Audit log →
 * Activity, Billing removed, Stuck cohorts added). Active state uses
 * pathname prefix matching so detail pages like /admin/customers/:id
 * still highlight the Customers nav item.
 */

interface NavItem {
  label: string
  href: string
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const NAV: NavGroup[] = [
  {
    label: 'Service health',
    items: [
      { label: 'Now', href: '/admin' },
    ],
  },
  {
    label: 'Customer support',
    items: [
      { label: 'Customers',   href: '/admin/customers' },
      { label: 'Subscribers', href: '/admin/subscribers' },
      { label: 'Pilots',      href: '/admin/pilots' },
    ],
  },
  {
    label: 'Quality',
    items: [
      { label: 'AI quality', href: '/admin/ai-quality' },
    ],
  },
  {
    label: 'Growth & revenue',
    items: [
      { label: 'Billing', href: '/admin/billing' },
    ],
  },
  {
    label: 'Activity',
    items: [
      { label: 'Events',    href: '/admin/events' },
      { label: 'Audit log', href: '/admin/audit-log' },
    ],
  },
]

export function AdminSidebar({ buildInfo }: { buildInfo: BuildInfo }) {
  const pathname = usePathname()

  return (
    <aside className="w-60 shrink-0 border-r border-slate-200 bg-white flex flex-col sticky top-0 self-start h-screen">
      <div className="p-4 border-b border-slate-100">
        <div className="flex items-center justify-between gap-2">
          <Logo size="sm" href="/admin" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-blue-600">
            Admin
          </span>
        </div>
      </div>

      <div className="p-3 border-b border-slate-100">
        <CmdKTrigger />
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4 text-sm" aria-label="Admin">
        {NAV.map((group) => (
          <div key={group.label}>
            <div className="px-3 mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {group.label}
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item)
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={
                        active
                          ? 'block px-3 py-1.5 rounded-lg bg-slate-900 text-white font-medium'
                          : 'block px-3 py-1.5 rounded-lg text-slate-600 hover:bg-slate-50'
                      }
                    >
                      {item.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-100 p-3 space-y-2">
        <EnvBadge buildInfo={buildInfo} />
        <Link
          href="/dashboard"
          className="block text-center text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg px-3 py-1.5"
        >
          ↩ Exit admin
        </Link>
      </div>
    </aside>
  )
}

function isActive(pathname: string, item: NavItem): boolean {
  // /admin (Now) needs an exact match — every admin page starts with
  // /admin so a prefix match would mark it active everywhere.
  if (item.href === '/admin') return pathname === '/admin'
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}
