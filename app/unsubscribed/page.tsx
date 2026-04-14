export default function UnsubscribedPage() {
  return (
    <main className="min-h-screen bg-[#f5f5f5] flex items-center justify-center px-6">
      <div className="max-w-md bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3">
          Unsubscribed
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-3">You&rsquo;re unsubscribed.</h1>
        <p className="text-sm text-slate-600">
          We won&rsquo;t email you again about this subscription. Sorry to see you go.
        </p>
      </div>
    </main>
  )
}
