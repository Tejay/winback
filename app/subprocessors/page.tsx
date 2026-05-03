import { SUBPROCESSORS } from '@/src/winback/lib/subprocessors'
import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Subprocessors — Winback' }

export default function SubprocessorsPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <StickyNav />
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3">
          Subprocessors
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2">Subprocessors.</h1>
        <p className="text-sm text-slate-500 mb-8">
          Last updated: 14 April 2026. These are the third parties we rely on to
          deliver the Winback service. When this list changes we notify customers
          at least 30 days in advance.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-wide text-slate-400 text-left">
                <th className="py-2 pr-4">Provider</th>
                <th className="py-2 pr-4">Purpose</th>
                <th className="py-2 pr-4">Location</th>
                <th className="py-2 pr-4">Transfer</th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map((s) => (
                <tr key={s.name} className="border-t border-slate-100 align-top">
                  <td className="py-3 pr-4 font-medium text-slate-900">
                    <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      {s.name}
                    </a>
                  </td>
                  <td className="py-3 pr-4 text-slate-600">{s.purpose}</td>
                  <td className="py-3 pr-4 text-slate-600">{s.location}</td>
                  <td className="py-3 pr-4 text-slate-600">{s.transferMechanism}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-slate-400 mt-8">
          To subscribe to change notifications, email{' '}
          <a href="mailto:privacy@winbackflow.co" className="text-blue-600 underline">
            privacy@winbackflow.co
          </a>.
        </p>
      </div>
    </main>
    <Footer />
    </div>
  )
}
