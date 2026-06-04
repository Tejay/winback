'use client'

import { useCmdK } from './cmdk-palette'

/**
 * The "Search… ⌘K" button in the sidebar. Opens the palette via the
 * CmdK provider's context. Keeping this as a separate component lets
 * the sidebar (which is itself a client component) compose it without
 * the trigger pulling in the palette's internals at module-load.
 */
export function CmdKTrigger() {
  const { open } = useCmdK()
  return (
    <button
      type="button"
      onClick={open}
      className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-white text-slate-500 text-xs"
      aria-label="Open command palette (⌘K)"
    >
      <span className="flex items-center gap-2">
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span>Search…</span>
      </span>
      <span className="font-mono text-[10px] text-slate-400">⌘K</span>
    </button>
  )
}
