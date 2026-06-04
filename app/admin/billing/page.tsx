import { redirect } from 'next/navigation'

/**
 * /admin/billing retired — its content (13-week MRR-recovered trend) moved
 * to /admin/insights, the business dashboard. Kept as a redirect so old
 * bookmarks and any stale nav links still resolve.
 */
export default function AdminBillingPage() {
  redirect('/admin/insights')
}
