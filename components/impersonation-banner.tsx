import { auth } from '@/lib/auth'
import { ImpersonationBannerClient } from './impersonation-banner-client'

/**
 * Spec 68 — server component that conditionally renders a top banner
 * when the active session is an admin impersonation. Renders nothing
 * for ordinary merchant sessions.
 */
export async function ImpersonationBanner() {
  const session = await auth()
  if (!session?.impersonator) return null

  return (
    <ImpersonationBannerClient
      targetEmail={session.user.email}
      adminEmail={session.impersonator.adminEmail}
      expiresAt={session.impersonator.expiresAt}
    />
  )
}
