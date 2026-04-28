import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Logo } from '@/components/logo'
import {
  consumeVerificationToken,
  markUserEmailVerified,
} from '@/src/winback/lib/email-verification'
import { logEvent } from '@/src/winback/lib/events'

// Token state changes on consume — never serve a cached render.
export const dynamic = 'force-dynamic'

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  const userId = await consumeVerificationToken(token ?? '')

  if (userId) {
    await markUserEmailVerified(userId)
    await logEvent({
      name: 'email_verified',
      userId,
      properties: {},
    })
    // Server-side redirect — keeps the browser URL clean and surfaces
    // the success banner on /login symmetrical with Spec 29's ?reset=1.
    redirect('/login?verified=1')
  }

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center">
      <div className="mt-12 mb-8">
        <Logo />
      </div>

      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">
          Link no longer valid.
        </h1>
        <p className="text-sm text-slate-500 mb-8">
          This verification link has expired or has already been used. Sign
          in to send yourself a fresh link.
        </p>
        <Link
          href="/login"
          className="block text-center w-full rounded-full px-5 py-2.5 text-sm font-medium bg-[#0f172a] text-white hover:bg-[#1e293b]"
        >
          Go to sign in
        </Link>
      </div>
    </div>
  )
}
