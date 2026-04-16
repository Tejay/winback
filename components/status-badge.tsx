type Status = 'pending' | 'contacted' | 'recovered' | 'lost' | 'skipped'

const config: Record<Status, { bg: string; text: string; border: string; icon: string }> = {
  recovered: { bg: 'bg-green-50',  text: 'text-green-700', border: 'border-green-200', icon: '✓' },
  contacted: { bg: 'bg-blue-50',   text: 'text-blue-700',  border: 'border-blue-200',  icon: '✉' },
  pending:   { bg: 'bg-amber-50',  text: 'text-amber-700', border: 'border-amber-200', icon: '○' },
  lost:      { bg: 'bg-slate-100', text: 'text-slate-500', border: 'border-slate-200', icon: '×' },
  skipped:   { bg: 'bg-slate-50',  text: 'text-slate-400', border: 'border-slate-200', icon: '–' },
}

interface StatusBadgeProps {
  status: Status
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const c = config[status] ?? config.pending
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}
    >
      <span>{c.icon}</span>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}
