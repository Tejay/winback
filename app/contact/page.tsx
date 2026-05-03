import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Contact — Winback' }

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <StickyNav />
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <h1 className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-8">
          Contact
        </h1>

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
          <div>Axiomis OÜ trading as Winback</div>
          <div>Reg. no. 17493372</div>
          <div>Sepapaja tn 6</div>
          <div>15551 Tallinn, Estonia</div>
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
    <Footer />
    </div>
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
