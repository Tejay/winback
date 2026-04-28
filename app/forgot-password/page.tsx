import { Logo } from '@/components/logo'
import { ForgotPasswordForm } from './form'

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ submitted?: string }>
}) {
  const { submitted } = await searchParams

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center">
      <div className="mt-12 mb-8">
        <Logo />
      </div>

      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">
          Reset your password.
        </h1>
        <p className="text-sm text-slate-500 mb-8">
          We&apos;ll email you a link to set a new password.
        </p>

        <ForgotPasswordForm initialSubmitted={submitted === '1'} />
      </div>
    </div>
  )
}
