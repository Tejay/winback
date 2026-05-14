import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { encode } from 'next-auth/jwt'
import { eq } from 'drizzle-orm'
import { auth, requireAdmin, getSessionCookieName } from '@/lib/auth'
import { db } from '@/lib/db'
import { users } from '@/lib/schema'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 68 — start impersonating a merchant.
 *
 * POST { targetUserId, confirmEmail }
 *
 * Replaces the admin's session cookie with a new JWT that:
 *   - has `id` = targetUserId (so `auth()` returns the merchant)
 *   - carries an `impersonator` claim with the admin's identity (so the
 *     banner can render and the stop endpoint can revert)
 *
 * Cookie expires 30 minutes from now — hard cap on impersonation.
 */
const IMPERSONATION_MAX_AGE_SECS = 30 * 60

export async function POST(req: Request) {
  const adminAuth = await requireAdmin()
  if ('error' in adminAuth) {
    return NextResponse.json({ error: adminAuth.error }, { status: adminAuth.status })
  }

  // Reject if already impersonating. The admin must stop first.
  const current = await auth()
  if (current?.impersonator) {
    return NextResponse.json(
      { error: 'Active impersonation; stop the current session first.' },
      { status: 409 },
    )
  }

  const body = await req.json().catch(() => ({}))
  const targetUserId = String(body.targetUserId ?? '')
  const confirmEmail = String(body.confirmEmail ?? '').trim().toLowerCase()
  if (!targetUserId || !confirmEmail) {
    return NextResponse.json(
      { error: 'targetUserId and confirmEmail are required' },
      { status: 400 },
    )
  }

  const [target] = await db
    .select({ id: users.id, email: users.email, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1)

  if (!target) {
    return NextResponse.json({ error: 'Target user not found' }, { status: 404 })
  }

  if (target.email.toLowerCase() !== confirmEmail) {
    return NextResponse.json(
      { error: 'confirmEmail does not match target user email' },
      { status: 400 },
    )
  }

  if (target.isAdmin) {
    return NextResponse.json(
      { error: 'Cannot impersonate another admin' },
      { status: 403 },
    )
  }

  // Look up the admin's email for the audit + banner display.
  const [admin] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, adminAuth.userId))
    .limit(1)

  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'NEXTAUTH_SECRET not configured' },
      { status: 503 },
    )
  }

  const cookieName = getSessionCookieName(req.url)
  const startedAt = new Date()
  const expiresAt = new Date(startedAt.getTime() + IMPERSONATION_MAX_AGE_SECS * 1000)

  const newToken = await encode({
    secret,
    salt: cookieName,
    maxAge: IMPERSONATION_MAX_AGE_SECS,
    token: {
      id: target.id,
      sub: target.id,
      email: target.email,
      impersonator: {
        adminId: adminAuth.userId,
        adminEmail: admin?.email ?? '(unknown)',
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    },
  })

  const isSecure = cookieName.startsWith('__Secure-')
  const cookieStore = await cookies()
  cookieStore.set(cookieName, newToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    path: '/',
    expires: expiresAt,
  })

  await logEvent({
    name: 'admin_action',
    userId: adminAuth.userId,
    properties: {
      action: 'impersonation_start',
      targetUserId: target.id,
      targetEmail: target.email,
      expiresAt: expiresAt.toISOString(),
    },
  })

  return NextResponse.json({
    ok: true,
    redirect: '/dashboard',
    expiresAt: expiresAt.toISOString(),
  })
}
