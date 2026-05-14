import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { encode } from 'next-auth/jwt'
import { eq } from 'drizzle-orm'
import { auth, getSessionCookieName } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 68 — stop impersonating; restore the admin's session.
 *
 * POST (no body).
 *
 * Reads the current session's `impersonator` claim, mints a fresh JWT
 * for the admin's identity, overwrites the cookie. Then looks up the
 * customer detail page the admin probably wants to return to.
 *
 * No requireAdmin gate — the gate is "you must currently be
 * impersonating", which only an admin could have triggered.
 */
const DEFAULT_SESSION_MAX_AGE_SECS = 30 * 24 * 60 * 60  // 30 days, NextAuth default

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.impersonator) {
    return NextResponse.json(
      { error: 'No active impersonation to stop' },
      { status: 400 },
    )
  }

  const { adminId, adminEmail, startedAt } = session.impersonator
  const targetUserId = session.user.id
  const targetEmail = session.user.email

  // Look up the customer detail page for the impersonated user so we can
  // bounce the admin back there. Falls back to /admin if the lookup misses.
  const [customerRow] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, targetUserId))
    .limit(1)

  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) {
    return NextResponse.json(
      { error: 'NEXTAUTH_SECRET not configured' },
      { status: 503 },
    )
  }

  // Confirm the admin row still exists / is still an admin. Defends against
  // an in-flight admin demotion mid-impersonation.
  const [admin] = await db
    .select({ id: users.id, email: users.email, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, adminId))
    .limit(1)

  if (!admin || !admin.isAdmin) {
    // Admin lost privileges — wipe the cookie entirely. Browser will
    // bounce to /login on next request.
    const cookieName = getSessionCookieName(req.url)
    const cookieStore = await cookies()
    cookieStore.delete(cookieName)
    await logEvent({
      name: 'admin_action',
      userId: adminId,
      properties: {
        action: 'impersonation_stop',
        targetUserId,
        targetEmail,
        outcome: 'admin_no_longer_authorized',
        elapsedSecs: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000),
      },
    })
    return NextResponse.json({ ok: true, redirect: '/login' })
  }

  const cookieName = getSessionCookieName(req.url)
  const isSecure = cookieName.startsWith('__Secure-')
  const restoredExpires = new Date(Date.now() + DEFAULT_SESSION_MAX_AGE_SECS * 1000)

  const restored = await encode({
    secret,
    salt: cookieName,
    maxAge: DEFAULT_SESSION_MAX_AGE_SECS,
    token: {
      id: admin.id,
      sub: admin.id,
      email: admin.email,
      // No impersonator field — back to a clean admin session.
    },
  })

  const cookieStore = await cookies()
  cookieStore.set(cookieName, restored, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure,
    path: '/',
    expires: restoredExpires,
  })

  await logEvent({
    name: 'admin_action',
    userId: admin.id,
    properties: {
      action: 'impersonation_stop',
      targetUserId,
      targetEmail,
      elapsedSecs: Math.round((Date.now() - new Date(startedAt).getTime()) / 1000),
    },
  })

  return NextResponse.json({
    ok: true,
    redirect: customerRow ? `/admin/customers/${customerRow.id}` : '/admin',
    adminEmail,
  })
}
