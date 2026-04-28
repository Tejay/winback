import Link from 'next/link'
import { Logo } from '@/components/logo'
import { validateResetToken } from '@/src/winback/lib/password-reset'
import { ResetPasswordForm } from './form'

// Token state changes on every consume — never serve a cached render.
export const dynamic = 'force-dynamic'

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  const validation = await validateResetToken(token ?? '')

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center">
      <div className="mt-12 mb-8">
        <Logo />
      </div>

      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        {validation.ok ? (
          <>
            <h1 className="text-2xl font-bold text-slate-900 mb-1">
              Set a new password.
            </h1>
            <p className="text-sm text-slate-500 mb-8">
              Choose something at least 8 characters.
            </p>
            <ResetPasswordForm token={token!} />
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-slate-900 mb-1">
              Link no longer valid.
            </h1>
            <p className="text-sm text-slate-500 mb-8">
              This reset link has expired or has already been used. Request a
              new one to continue.
            </p>
            <Link
              href="/forgot-password"
              className="block text-center w-full rounded-full px-5 py-2.5 text-sm font-medium bg-[#0f172a] text-white hover:bg-[#1e293b]"
            >
              Request a new link
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
