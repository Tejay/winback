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
  // Always-200 contract: this endpoint must not leak whether an email is
  // registered, so every branch returns the same response shape.
  const ok = NextResponse.json({ ok: true })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return ok
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) return ok

  const email = parsed.data.email.trim().toLowerCase()
  const userId = await findUserIdByEmail(email)
  if (!userId) return ok

  const recent = await recentTokenCount({ userId, windowMs: RATE_WINDOW_MS })
  if (recent >= MAX_PER_EMAIL) return ok

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

  return ok
}
