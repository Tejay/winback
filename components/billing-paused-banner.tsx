import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'

/**
 * Red top strip shown when the merchant's platform subscription is in
 * a non-paying state (incomplete_expired / canceled / unpaid / paused
 * — see src/winback/lib/billing-enforcement.ts for the predicate).
 *
 * While this banner is showing:
 *   - classifier-tick skips this merchant's rows (no Anthropic spend)
 *   - sendEmail / sendReplyEmail / sendDunningEmail /
 *     sendDunningFollowupEmail all skip (no Resend spend, no emails
 *     to the merchant's subscribers)
 *   - dashboard reads + webhook ingestion still work (history is
 *     preserved so when billing heals, everything resumes)
 *
 * Mounted at the top of /dashboard. Visible above the fold; not
 * dismissible because the cost of dismissing-and-forgetting is real
 * service loss.
 */
export function BillingPausedBanner() {
  return (
    <div
      role="alert"
      className="border-b border-rose-200 bg-rose-50 px-6 py-3"
    >
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-rose-700 flex-shrink-0 mt-0.5" aria-hidden />
          <div className="text-sm text-rose-900 leading-relaxed">
            <strong>Service paused — your subscription needs attention.</strong>{' '}
            Winback isn&rsquo;t classifying new cancellations or sending
            win-back / payment-recovery emails until your billing is
            restored.
          </div>
        </div>
        <Link
          href="/settings#billing"
          className="bg-rose-600 hover:bg-rose-700 text-white rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap flex-shrink-0 text-center"
        >
          Restore billing &rarr;
        </Link>
      </div>
    </div>
  )
}
