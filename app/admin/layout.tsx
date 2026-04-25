import { redirect } from 'next/navigation'
import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { Logo } from '@/components/logo'

/**
 * Spec 25 — Admin shell.
 *
 * Server-side gate via requireAdmin(). Unsigned-in users go to /login;
 * signed-in non-admins get bounced to /dashboard (their normal home) so
 * they don't see a 403 page that leaks the existence of /admin.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const result = await requireAdmin()
  if ('error' in result) {
    if (result.status === 401) redirect('/login')
    redirect('/dashboard')
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <nav className="sticky top-0 z-30 bg-white border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Logo />
            <span className="text-xs font-semibold uppercase tracking-widest text-blue-600">
              Admin
            </span>
          </div>
          <div className="flex items-center gap-1 text-sm">
            <NavLink href="/admin">Overview</NavLink>
            <NavLink href="/admin/customers">Customers</NavLink>
            <NavLink href="/admin/subscribers">Subscribers</NavLink>
            <NavLink href="/admin/ai-quality">AI quality</NavLink>
            <NavLink href="/admin/billing">Billing</NavLink>
            <NavLink href="/admin/events">Events</NavLink>
            <Link
              href="/dashboard"
              className="ml-3 text-xs text-slate-400 hover:text-slate-600"
            >
              ↩ Exit admin
            </Link>
          </div>
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-6 py-8">{children}</main>
    </div>
  )
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 rounded-full text-sm font-medium text-slate-700 hover:bg-slate-100"
    >
      {children}
    </Link>
  )
}
