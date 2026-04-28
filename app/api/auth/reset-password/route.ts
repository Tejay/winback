import { NextResponse } from 'next/server'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { consumeResetToken } from '@/src/winback/lib/password-reset'
import { logEvent } from '@/src/winback/lib/events'

const schema = z.object({
  token:    z.string().min(1),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirm:  z.string().optional(),
})

export async function POST(req: Request) {
  // Detect whether this is a native HTML form POST (no JS) or a fetch from
  // our React handler. Form posts get 303 redirects (so the browser
  // navigates); fetch posts get JSON responses.
  const contentType = req.headers.get('content-type') ?? ''
  const isFormPost =
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')

  // Resolve the public origin so redirects sent through ngrok / Vercel's
  // proxy don't bounce to localhost.
  function publicOrigin(): string {
    if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host')
    const proto = req.headers.get('x-forwarded-proto') ?? 'https'
    if (host) return `${proto}://${host}`
    return new URL(req.url).origin
  }
  const origin = publicOrigin()

  function formError(token: string, code: 'invalid' | 'mismatch' | 'expired') {
    const url = new URL('/reset-password', origin)
    url.searchParams.set('token', token)
    url.searchParams.set('pwError', code)
    return NextResponse.redirect(url, 303)
  }

  let body: { token?: unknown; password?: unknown; confirm?: unknown }
  try {
    if (isFormPost) {
      const form = await req.formData()
      body = {
        token:    form.get('token'),
        password: form.get('password'),
        confirm:  form.get('confirm'),
      }
    } else {
      body = (await req.json()) as typeof body
    }
  } catch {
    return isFormPost
      ? NextResponse.redirect(`${origin}/forgot-password`, 303)
      : NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    if (isFormPost) {
      return formError(String(body.token ?? ''), 'invalid')
    }
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    )
  }

  const { token, password, confirm } = parsed.data

  // Confirm-match: only enforced server-side for the form path. The fetch
  // path checks this client-side before submitting, so JS users never
  // include `confirm` in the JSON body.
  if (isFormPost && typeof confirm === 'string' && confirm !== password) {
    return formError(token, 'mismatch')
  }

  const userId = await consumeResetToken(token)
  if (!userId) {
    await logEvent({
      name: 'password_reset_invalid',
      properties: {},
    })
    if (isFormPost) {
      // Token now invalid — redirect to /reset-password without pwError;
      // the page's validateResetToken will render "Link no longer valid".
      const url = new URL('/reset-password', origin)
      url.searchParams.set('token', token)
      return NextResponse.redirect(url, 303)
    }
    return NextResponse.json(
      { error: 'This reset link has expired or has already been used.' },
      { status: 410 },
    )
  }

  const passwordHash = await bcrypt.hash(password, 12)
  await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, userId))

  await logEvent({
    name: 'password_reset_completed',
    userId,
    properties: {},
  })

  if (isFormPost) {
    return NextResponse.redirect(`${origin}/login?reset=1`, 303)
  }
  return NextResponse.json({ ok: true })
}
