import { redirect } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { getBuildInfo } from '@/lib/admin/build-info'
import { AdminSidebar } from '@/components/admin/sidebar'
import { CmdKProvider } from '@/components/admin/cmdk-palette'
import { Breadcrumbs } from '@/components/admin/breadcrumbs'

/**
 * Admin shell — PR 1.
 *
 * Left sidebar (grouped nav + Cmd-K trigger + env/SHA footer) replaces
 * the previous topbar pills. CmdKProvider wraps the layout so any
 * descendant client component can open the palette via useCmdK(). A
 * breadcrumb slot renders above page content.
 *
 * Auth gating unchanged: server-side requireAdmin(); 401 → /login,
 * non-admin → /dashboard. We don't render a 403 so /admin's existence
 * stays hidden from non-admins.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const result = await requireAdmin()
  if ('error' in result) {
    if (result.status === 401) redirect('/login')
    redirect('/dashboard')
  }

  const buildInfo = getBuildInfo()

  return (
    <CmdKProvider>
      <div className="min-h-screen bg-[#f5f5f5] flex">
        <AdminSidebar buildInfo={buildInfo} />
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="px-8 pt-5 pb-2">
            <Breadcrumbs />
          </div>
          <main className="flex-1 px-8 pb-10">
            <div className="max-w-7xl">{children}</div>
          </main>
        </div>
      </div>
    </CmdKProvider>
  )
}
