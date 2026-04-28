import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  findUserForResend,
  issueVerificationToken,
  recentVerificationTokenCount,
} from '@/src/winback/lib/email-verification'
import { sendVerificationEmail } from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'

const schema = z.object({
  email: z.string().email(),
})

const RATE_WINDOW_MS = 15 * 60_000
const MAX_PER_USER = 3

/**
 * POST /api/auth/resend-verification
 *
 * Spec 32 — re-sends the email-verification link for a user whose account
 * exists but who hasn't clicked the original. Always-200 (no enumeration),
 * mirrors the Spec 29 /api/auth/forgot-password contract:
 *
 *   - Unknown email → 200, no email sent
 *   - Known email, already verified → 200, no email sent
 *   - Known unverified, rate-limit hit → 200, no email sent
 *   - Known unverified, OK → 200, prior tokens invalidated, fresh email sent
 *
 * Form-encoded path → 303 redirect to /login?verifySent=1 so a no-JS user
 * gets clear feedback. JSON path → { ok: true }.
 */
export async function POST(req: Request) {
  const contentType = req.headers.get('content-type') ?? ''
  const isFormPost =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')

  function publicOrigin(): string {
    if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
    const proto = req.headers.get('x-forwarded-proto') ?? 'https'
    if (host) return `${proto}://${host}`
    return new URL(req.url).origin
  }

  const okResponse = isFormPost
    ? NextResponse.redirect(`${publicOrigin()}/login?verifySent=1`, 303)
    : NextResponse.json({ ok: true })

  let body: unknown
  try {
    if (isFormPost) {
      const form = await req.formData()
      body = { email: form.get('email') }
    } else {
      body = await req.json()
    }
  } catch {
    return okResponse
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return okResponse

  const email = parsed.data.email.trim().toLowerCase()
  const user = await findUserForResend(email)
  if (!user) return okResponse                          // unknown — silent
  if (user.emailVerifiedAt) return okResponse           // already verified — silent

  const recent = await recentVerificationTokenCount({
    userId:   user.id,
    windowMs: RATE_WINDOW_MS,
  })
  if (recent >= MAX_PER_USER) return okResponse         // rate-limited — silent

  const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null
  const rawToken = await issueVerificationToken({ userId: user.id, ipAddress })
  const verifyUrl = `${publicOrigin()}/verify-email?token=${encodeURIComponent(rawToken)}`

  try {
    await sendVerificationEmail({
      to:          email,
      founderName: null,    // we don't fetch the customer row here; greeting falls back to "Hi there,"
      verifyUrl,
    })
  } catch (err) {
    console.error('[resend-verification] send failed:', err)
  }

  await logEvent({
    name:   'verification_email_resent',
    userId: user.id,
    properties: {},
  })

  return okResponse
}
