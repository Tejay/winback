import Link from 'next/link'
import { Pause, Trash2 } from 'lucide-react'
import { PauseToggle } from './pause-toggle'

interface DangerZoneProps {
  paused: boolean
}

export function DangerZone({ paused }: DangerZoneProps) {
  return (
    <div className="bg-rose-50/40 border border-rose-200 rounded-2xl p-6 mt-6">
      <div className="text-xs font-semibold tracking-widest uppercase text-rose-600">
        Danger zone
      </div>
      <h2 className="text-xl font-semibold text-slate-900 mt-1">
        Stop Winback from sending
      </h2>
      <p className="text-sm text-slate-500 mt-1 mb-5">
        Safe to use. Cancellations keep flowing in — nothing is sent until you resume.
      </p>

      {/* Pause row */}
      <div className="bg-white border border-rose-100 rounded-2xl p-4 mb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="bg-rose-50 rounded-xl w-9 h-9 flex items-center justify-center flex-shrink-0">
              <Pause className="w-4 h-4 text-rose-600" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">
                Pause all winback emails
              </div>
              <div className="text-xs text-slate-500 mt-0.5 max-w-md">
                Temporarily stop sending any winback email. Useful during
                incidents, launches, or while you rework your changelog.
              </div>
            </div>
          </div>
          <div className="flex-shrink-0">
            <PauseToggle initialPaused={paused} compact />
          </div>
        </div>
      </div>

      {/* Delete row */}
      <div className="bg-white border border-rose-100 rounded-2xl p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="bg-rose-50 rounded-xl w-9 h-9 flex items-center justify-center flex-shrink-0">
              <Trash2 className="w-4 h-4 text-rose-600" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">
                Delete workspace
              </div>
              <div className="text-xs text-slate-500 mt-0.5 max-w-md">
                Permanently remove your Winback workspace, disconnect Stripe and
                Gmail, and cancel billing. This can&rsquo;t be undone.
              </div>
            </div>
          </div>
          <Link
            href="/settings/delete"
            className="flex-shrink-0 border border-rose-300 text-rose-700 bg-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-rose-50"
          >
            Delete workspace
          </Link>
        </div>
      </div>
    </div>
  )
}
