import { Logo } from '@/components/logo'

const FAILURE_MESSAGES: Record<string, { emoji: string; title: string; body: string }> = {
  subscriber_not_found: {
    emoji: '🔗',
    title: 'This link is no longer valid',
    body: "It may have expired or been used already. If you'd like to resubscribe, please reach out to us directly.",
  },
  account_disconnected: {
    emoji: '⚙️',
    title: 'Reactivation is temporarily unavailable',
    body: "We're unable to process resubscriptions right now. Please contact us and we'll get you set up.",
  },
  price_unavailable: {
    emoji: '📋',
    title: "We've updated our plans",
    body: "The plan you were on isn't offered anymore. Drop us a line and we'll find one that fits.",
  },
  checkout_failed: {
    emoji: '⚠️',
    title: 'Something went wrong on our end',
    body: 'Please try again in a moment, or contact us if it keeps happening.',
  },
}

export default async function WelcomeBackPage({
  searchParams,
}: {
  searchParams: Promise<{ recovered?: string; reason?: string }>
}) {
  const { recovered, reason } = await searchParams
  const isRecovered = recovered === 'true'

  // If a failure reason is supplied and we recognise it, show the contextual
  // message. Otherwise fall back to the generic "no worries" copy.
  const failure = !isRecovered && reason ? FAILURE_MESSAGES[reason] : null

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
        ) : failure ? (
          <>
            <div className="text-4xl mb-4">{failure.emoji}</div>
            <h1 className="text-2xl font-bold text-slate-900 mb-2">
              {failure.title}
            </h1>
            <p className="text-sm text-slate-500">
              {failure.body}
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
