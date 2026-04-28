import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  findUserIdByEmail,
  issueResetToken,
  recentTokenCount,
} from '@/src/winback/lib/password-reset'
import { sendPasswordResetEmail } from '@/src/winback/lib/email'

const schema = z.object({
  email: z.string().email(),
})

const RATE_WINDOW_MS = 15 * 60_000
const MAX_PER_EMAIL = 3

export async function POST(req: Request) {
  // Detect whether this is a native HTML form POST (no JS) or a fetch from
  // our React handler. HTML forms send application/x-www-form-urlencoded
  // (or multipart/form-data) and expect a 303 redirect; fetch sends JSON
  // and expects { ok: true }.
  const contentType = req.headers.get('content-type') ?? ''
  const isFormPost =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')

  // Always-OK contract: this endpoint must not leak whether an email is
  // registered, so every branch returns the same response.
  const okResponse = isFormPost
    ? NextResponse.redirect(new URL('/forgot-password?submitted=1', req.url), 303)
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
  const userId = await findUserIdByEmail(email)
  if (!userId) return okResponse

  const recent = await recentTokenCount({ userId, windowMs: RATE_WINDOW_MS })
  if (recent >= MAX_PER_EMAIL) return okResponse

  const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null
  const rawToken = await issueResetToken({ userId, ipAddress })

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  const resetUrl = `${base}/reset-password?token=${encodeURIComponent(rawToken)}`

  try {
    await sendPasswordResetEmail({ to: email, resetUrl })
  } catch (err) {
    // Swallow — surfacing send failures here would leak account existence
    // (different latency / status). Token is still valid; founder can
    // request another in 15 min if the email never arrives.
    console.error('[forgot-password] send failed:', err)
  }

  return okResponse
}
