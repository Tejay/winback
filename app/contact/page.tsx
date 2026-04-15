export const metadata = { title: 'Contact — Winback' }

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-[#f5f5f5] py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3">
          Contact
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2">Contact.</h1>
        <p className="text-sm text-slate-500 mb-8">
          Real humans, one business-day response during UK working hours.
        </p>

        <div className="space-y-6">
          <ContactBlock
            label="Support"
            email="support@winbackflow.co"
            note="Product questions, billing, attribution disputes. Reply within 1 business day."
          />
          <ContactBlock
            label="Privacy &amp; GDPR requests"
            email="privacy@winbackflow.co"
            note="Data access, correction, deletion (Article 15-17), DPA questions. Reply within 30 days per Article 12."
          />
          <ContactBlock
            label="Security"
            email="security@winbackflow.co"
            note="Responsible-disclosure: 90-day window. We will not threaten or pursue good-faith security researchers."
          />
          <ContactBlock
            label="Abuse reports"
            email="abuse@winbackflow.co"
            note="If you received a Winback email you believe is spam or otherwise breaches our Acceptable Use Policy. Triage within 1 business day."
          />
        </div>

        <div className="mt-10 pt-6 border-t border-slate-100 text-sm text-slate-600 leading-relaxed">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">
            Registered office
          </div>
          <div>Winback Ltd</div>
          <div>Company no. {'{TO_FILL — pending Companies House}'}</div>
          <div>{'{Registered office address — pending incorporation}'}</div>
          <div>England and Wales</div>
        </div>

        <p className="mt-8 text-xs text-slate-400">
          See also:{' '}
          <a href="/terms" className="hover:text-slate-600">Terms</a> ·{' '}
          <a href="/refunds" className="hover:text-slate-600">Refunds</a> ·{' '}
          <a href="/aup" className="hover:text-slate-600">Acceptable Use</a> ·{' '}
          <a href="/privacy" className="hover:text-slate-600">Privacy</a> ·{' '}
          <a href="/dpa" className="hover:text-slate-600">DPA</a>
        </p>
      </div>
    </main>
  )
}

function ContactBlock({
  label,
  email,
  note,
}: {
  label: string
  email: string
  note: string
}) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">
        <span dangerouslySetInnerHTML={{ __html: label }} />
      </div>
      <a
        href={`mailto:${email}`}
        className="text-sm font-medium text-blue-600 hover:underline"
      >
        {email}
      </a>
      <p className="text-sm text-slate-500 mt-1 leading-relaxed">{note}</p>
    </div>
  )
}
