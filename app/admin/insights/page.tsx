import { InsightsClient } from './insights-client'

/**
 * /admin/insights — business dashboard. Replaces the old /admin/billing
 * page and the business-metrics disclosure that used to live on Now.
 * Layout gates via requireAdmin; client polls on demand (load-once + a
 * window selector), so no gate needed here.
 */
export default function AdminInsightsPage() {
  return <InsightsClient />
}
