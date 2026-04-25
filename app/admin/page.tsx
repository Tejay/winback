import { OverviewClient } from './overview-client'

/**
 * Spec 25 — /admin overview page.
 *
 * Server component is just a shell — the client component polls
 * /api/admin/overview every 30s. The layout already gates via
 * requireAdmin so we don't need to gate again here.
 */
export default function AdminOverviewPage() {
  return <OverviewClient />
}
