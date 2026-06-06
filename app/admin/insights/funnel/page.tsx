import { FunnelClient } from './funnel-client'

/** /admin/insights/funnel — merchant acquisition/activation funnel. Auth is
 *  enforced by app/admin/layout.tsx (requireAdmin). */
export default function AdminFunnelPage() {
  return <FunnelClient />
}
