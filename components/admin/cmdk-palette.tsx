'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'

/**
 * Admin command palette (⌘K / Ctrl+K).
 *
 * Two layers:
 *  - CmdKProvider: wraps the admin layout. Owns open/closed state and
 *    installs the global keyboard listener. Pages and the sidebar
 *    trigger via the useCmdK() hook.
 *  - CmdKPalette: the dialog itself, mounted when isOpen. Debounced
 *    fetch → /api/admin/search, arrow-key navigation, Enter to open.
 *
 * v1 is navigate-only. Action runner ("Impersonate X", "Pause X") is
 * deferred to a later PR — adding it now bloats the surface and forces
 * confirmation flows into the palette before we know how operators
 * actually use it.
 */

interface CmdKContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
}

const CmdKContext = createContext<CmdKContextValue | null>(null)

export function useCmdK(): CmdKContextValue {
  const v = useContext(CmdKContext)
  if (!v) throw new Error('useCmdK must be used inside <CmdKProvider>')
  return v
}

export function CmdKProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const open   = useCallback(() => setIsOpen(true),  [])
  const close  = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘K on mac, Ctrl+K elsewhere. Browsers don't claim this combo
      // for any default action that matters for admins, so we always
      // preventDefault when triggered.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setIsOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const ctx = useMemo(
    () => ({ isOpen, open, close, toggle }),
    [isOpen, open, close, toggle],
  )

  return (
    <CmdKContext.Provider value={ctx}>
      {children}
      {isOpen && <CmdKPalette onClose={close} />}
    </CmdKContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

interface CustomerHit {
  id: string
  email: string
  founderName: string | null
  productName: string | null
  plan: string | null
  stripeConnected: boolean
}
interface SubscriberHit {
  id: string
  customerId: string
  customerLabel: string
  email: string | null
  name: string | null
  status: string
  doNotContact: boolean
}
interface EventHit {
  id: string
  name: string
  customerId: string | null
  customerEmail: string | null
  createdAt: string
}
interface SearchResponse {
  customers: CustomerHit[]
  subscribers: SubscriberHit[]
  events: EventHit[]
}

interface FlatItem {
  key: string
  group: 'Customers' | 'Subscribers' | 'Recent events'
  href: string
  primary: string
  secondary: string
  meta?: string
}

function flatten(r: SearchResponse | null): FlatItem[] {
  if (!r) return []
  const items: FlatItem[] = []
  for (const c of r.customers) {
    items.push({
      key: `c:${c.id}`,
      group: 'Customers',
      href: `/admin/customers/${c.id}`,
      primary: c.founderName ?? c.email,
      secondary: `${c.email}${c.productName ? ` · ${c.productName}` : ''}`,
      meta: `${c.plan ?? 'trial'}${c.stripeConnected ? ' · ✓ Stripe' : ' · ✗ Stripe'}`,
    })
  }
  for (const s of r.subscribers) {
    items.push({
      key: `s:${s.id}`,
      group: 'Subscribers',
      href: `/admin/subscribers/${s.id}`,
      primary: s.name ?? s.email ?? '(no name)',
      secondary: `${s.email ?? '—'} on ${s.customerLabel}`,
      meta: `${s.status}${s.doNotContact ? ' · DNC' : ''}`,
    })
  }
  for (const e of r.events) {
    items.push({
      key: `e:${e.id}`,
      group: 'Recent events',
      href: e.customerId
        ? `/admin/events?customer=${e.customerId}&name=${encodeURIComponent(e.name)}`
        : `/admin/events?name=${encodeURIComponent(e.name)}`,
      primary: e.name,
      secondary: e.customerEmail ?? e.customerId?.slice(0, 8) ?? '—',
      meta: relTime(e.createdAt),
    })
  }
  return items
}

function CmdKPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedIdx, setSelectedIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Auto-focus the input on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // Debounced search. 150ms is brisk but lets backspace bursts collapse
  // into one request.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults(null)
      setLoading(false)
      setError(null)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/search?q=${encodeURIComponent(term)}`,
          { signal: ctrl.signal, cache: 'no-store' },
        )
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          throw new Error(j.error ?? `Search failed (${res.status})`)
        }
        const json: SearchResponse = await res.json()
        setResults(json)
        setError(null)
        setSelectedIdx(0)
      } catch (e: unknown) {
        // AbortError is normal when the user keeps typing — ignore it.
        if (e instanceof DOMException && e.name === 'AbortError') return
        if (e instanceof Error && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : String(e))
        setResults(null)
      } finally {
        setLoading(false)
      }
    }, 150)
    return () => { ctrl.abort(); clearTimeout(t) }
  }, [q])

  const items = useMemo(() => flatten(results), [results])

  // Arrow keys + Enter + Escape. Bound to window so it works regardless
  // of which sub-element has focus inside the palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIdx((i) => Math.min(i + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[selectedIdx]
        if (item) {
          router.push(item.href)
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, selectedIdx, router, onClose])

  // Scroll the selected row into view when arrow keys move past the
  // visible area.
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${selectedIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh] bg-slate-900/30"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Search admin"
    >
      <div
        className="w-full max-w-2xl bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-3">
          <svg className="w-4 h-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search customers, subscribers, recent events…"
            className="flex-1 text-sm outline-none bg-transparent"
            aria-label="Search query"
          />
          {loading && <span className="text-[10px] text-slate-400">searching…</span>}
          <span className="font-mono text-[10px] text-slate-400">esc</span>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto text-[13px]">
          {q.trim().length < 2 ? (
            <CmdKHints />
          ) : error ? (
            <div className="px-4 py-6 text-rose-700 text-sm">{error}</div>
          ) : items.length === 0 && !loading ? (
            <div className="px-4 py-8 text-center text-slate-400 text-sm">
              No matches for &ldquo;{q.trim()}&rdquo;.
            </div>
          ) : (
            <CmdKList
              items={items}
              selectedIdx={selectedIdx}
              onSelect={(href) => { router.push(href); onClose() }}
              onHover={setSelectedIdx}
            />
          )}
        </div>

        <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-between text-[10px] text-slate-400">
          <div className="flex gap-3">
            <span><span className="font-mono">↑↓</span> navigate</span>
            <span><span className="font-mono">↵</span> open</span>
            <span><span className="font-mono">esc</span> close</span>
          </div>
          <span>v1 · navigate only · actions coming</span>
        </div>
      </div>
    </div>
  )
}

function CmdKHints() {
  return (
    <div className="px-4 py-6 text-[12px] text-slate-500 space-y-2">
      <div>Search across:</div>
      <ul className="list-disc list-inside marker:text-slate-300 space-y-1">
        <li><strong>Customers</strong> — email, founder name, product, Stripe acct</li>
        <li><strong>Subscribers</strong> — email or name</li>
        <li><strong>Recent events</strong> — event name or matching customer</li>
      </ul>
      <div className="pt-2 text-[11px] text-slate-400">Type 2+ characters to start.</div>
    </div>
  )
}

function CmdKList({
  items,
  selectedIdx,
  onSelect,
  onHover,
}: {
  items: FlatItem[]
  selectedIdx: number
  onSelect: (href: string) => void
  onHover: (idx: number) => void
}) {
  // Render group headers inline. Items are already grouped by flatten().
  const rows: React.ReactNode[] = []
  let lastGroup: string | null = null
  items.forEach((item, idx) => {
    if (item.group !== lastGroup) {
      rows.push(
        <div
          key={`g:${item.group}`}
          className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-50 sticky top-0"
        >
          {item.group}
        </div>,
      )
      lastGroup = item.group
    }
    const selected = idx === selectedIdx
    rows.push(
      <div
        key={item.key}
        data-idx={idx}
        onMouseEnter={() => onHover(idx)}
        onClick={() => onSelect(item.href)}
        className={
          'px-4 py-2 cursor-pointer flex items-center gap-3 ' +
          (selected ? 'bg-blue-50' : 'hover:bg-slate-50')
        }
      >
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-900 truncate">{item.primary}</div>
          <div className="text-[11px] text-slate-500 truncate">{item.secondary}</div>
        </div>
        {item.meta && <span className="text-[11px] text-slate-400 shrink-0">{item.meta}</span>}
        {selected && <span className="font-mono text-[10px] text-slate-400">↵</span>}
      </div>,
    )
  })
  return <div className="divide-y divide-slate-100">{rows}</div>
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
