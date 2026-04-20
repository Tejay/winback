'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { Logo } from './logo'
import { LogOut } from 'lucide-react'

interface TopNavProps {
  userName?: string | null
}

export function TopNav({ userName }: TopNavProps) {
  const pathname = usePathname()

  const navItems = [
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/settings', label: 'Settings' },
  ]

  const initial = userName?.charAt(0)?.toUpperCase() ?? '?'

  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-slate-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 flex items-center justify-between h-14 gap-2">
        <Logo href="/dashboard" size="sm" />

        <div className="flex items-center gap-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  isActive
                    ? 'bg-[#0f172a] text-white rounded-full px-3 sm:px-4 py-1.5 text-sm font-medium'
                    : 'text-slate-500 hover:text-slate-900 px-3 sm:px-4 py-1.5 text-sm font-medium'
                }
              >
                {item.label}
              </Link>
            )
          })}
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-white text-sm font-medium flex-shrink-0">
            {initial}
          </div>
          <span className="hidden sm:inline text-sm text-slate-700 font-medium">{userName ?? 'User'}</span>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="text-slate-400 hover:text-slate-600 flex-shrink-0"
            aria-label="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </nav>
  )
}
