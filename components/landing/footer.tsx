import Link from 'next/link'

/**
 * Site footer — extracted from `app/page.tsx` so the new `/payment-recovery`
 * and `/win-back` pages can share it. Pure server component, no state.
 */
export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-start justify-between gap-6 text-xs text-slate-500">
        <div className="leading-relaxed">
          <div>© {new Date().getFullYear()} Winback Ltd · Company no. {'{TO_FILL}'}</div>
          <div>{'{Registered office address — pending incorporation}'}</div>
          <div>
            <a href="mailto:support@winbackflow.co" className="hover:text-slate-900">
              support@winbackflow.co
            </a>
          </div>
        </div>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
          <Link href="/faq" className="hover:text-slate-900">FAQ</Link>
          <Link href="/contact" className="hover:text-slate-900">Contact</Link>
          <Link href="/refunds" className="hover:text-slate-900">Refunds</Link>
          <Link href="/aup" className="hover:text-slate-900">Acceptable Use</Link>
          <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
          <Link href="/terms" className="hover:text-slate-900">Terms</Link>
          <Link href="/dpa" className="hover:text-slate-900">DPA</Link>
          <Link href="/subprocessors" className="hover:text-slate-900">Subprocessors</Link>
        </nav>
      </div>
    </footer>
  )
}
