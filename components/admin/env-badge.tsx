'use client'

import { useEffect, useState } from 'react'
import type { BuildInfo } from '@/lib/admin/build-info'

/**
 * Sidebar footer: ENV badge + short SHA + "deployed Nh ago".
 *
 * Client-rendered so the relative timestamp refreshes every minute
 * without forcing the whole page to re-render. The build/sha/author
 * values are still server-computed and passed in as props.
 */
export function EnvBadge({ buildInfo }: { buildInfo: BuildInfo }) {
  const envLabel = buildInfo.env === 'production' ? 'PROD'
    : buildInfo.env === 'preview' ? 'PREV'
    : 'DEV'
  const envClass = buildInfo.env === 'production' ? 'bg-amber-100 text-amber-800'
    : buildInfo.env === 'preview' ? 'bg-blue-100 text-blue-800'
    : 'bg-slate-200 text-slate-700'

  const [agoLabel, setAgoLabel] = useState(() => relativeAgo(buildInfo.buildTime))
  useEffect(() => {
    if (!buildInfo.buildTime) return
    const t = setInterval(() => setAgoLabel(relativeAgo(buildInfo.buildTime)), 60_000)
    return () => clearInterval(t)
  }, [buildInfo.buildTime])

  return (
    <div className="text-[10px] space-y-1">
      <div className="flex items-center gap-1.5">
        <span
          className={`px-1.5 py-0.5 rounded font-bold tracking-wider ${envClass}`}
          title={`Environment: ${buildInfo.env}`}
        >
          {envLabel}
        </span>
        {buildInfo.sha && (
          <span
            className="font-mono text-slate-500"
            title={buildInfo.fullSha ?? undefined}
          >
            {buildInfo.sha}
          </span>
        )}
      </div>
      {buildInfo.buildTime ? (
        <div className="text-slate-400" suppressHydrationWarning>
          deployed {agoLabel}
          {buildInfo.author && <> · by {buildInfo.author}</>}
        </div>
      ) : (
        <div className="text-slate-400">local build</div>
      )}
    </div>
  )
}

function relativeAgo(date: Date | null): string {
  if (!date) return ''
  const ms = Date.now() - date.getTime()
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
