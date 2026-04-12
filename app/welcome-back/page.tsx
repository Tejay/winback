import { Logo } from '@/components/logo'

export default async function WelcomeBackPage({
  searchParams,
}: {
  searchParams: Promise<{ recovered?: string }>
}) {
  const { recovered } = await searchParams
  const isRecovered = recovered === 'true'

  return (
    <div className="min-h-screen bg-[#f5f5f5] flex flex-col items-center justify-center">
      <div className="mb-8">
        <Logo />
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 max-w-sm text-center">
        {isRecovered ? (
          <>
            <div className="text-4xl mb-4">🎉</div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">
              Welcome back!
            </h1>
            <p className="text-sm text-slate-500">
              Thanks for giving us another try. Your subscription is active again.
            </p>
          </>
        ) : (
          <>
            <div className="text-4xl mb-4">👋</div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">
              No worries.
            </h1>
            <p className="text-sm text-slate-500">
              You can come back anytime. We&apos;ll keep improving.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
