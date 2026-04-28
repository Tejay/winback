import { NextResponse } from 'next/server'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { users, customers, legalAcceptances, pilotTokens } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'
import {
  consumePilotToken,
  validatePilotToken,
  PILOT_DURATION_DAYS,
} from '@/src/winback/lib/pilot'

const LEGAL_VERSION = '2026-04-14'

const registerSchema = z.object({
  name:          z.string().min(1, 'Name is required'),
  email:         z.string().email('Invalid email'),
  password:      z.string().min(8, 'Password must be at least 8 characters'),
  acceptedLegal: z.literal(true, { message: 'You must accept the Terms, Privacy Policy, and DPA' }),
  pilotToken:    z.string().optional(),
})

export async function POST(req: Request) {
  // Detect native HTML form POSTs (no JS / pre-hydration) vs fetch from
  // the React handler. Form posts get a 303 redirect after success;
  // fetch gets JSON. Same pattern as Spec 30 /api/auth/forgot-password.
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

  let body: Record<string, unknown> = {}
  if (isFormPost) {
    const form = await req.formData()
    body = {
      name:          form.get('name'),
      email:         form.get('email'),
      password:      form.get('password'),
      // Native checkbox sends 'on' when ticked; coerce to boolean true.
      acceptedLegal: form.get('acceptedLegal') !== null,
      pilotToken:    form.get('pilotToken') || undefined,
    }
  } else {
    body = await req.json()
  }

  const parsed = registerSchema.safeParse(body)

  function fail(msg: string, status: number) {
    if (isFormPost) {
      const url = new URL('/register', publicOrigin())
      const tk = body.pilotToken
      if (typeof tk === 'string' && tk) url.searchParams.set('pilotToken', tk)
      url.searchParams.set('error', msg)
      return NextResponse.redirect(url, 303)
    }
    return NextResponse.json({ error: msg }, { status })
  }

  if (!parsed.success) {
    return fail(parsed.error.issues[0].message, 400)
  }

  const { name, email, password, pilotToken } = parsed.data

  // Spec 31 (revised) — pilot redemption is now a HARD precondition. If
  // the founder arrived with a pilotToken, it must be valid (unused,
  // unexpired) BEFORE we create any user/customer rows. A stale link
  // silently turning into a non-pilot account confuses founders into
  // thinking they're on a free plan when they're not, and risks billing
  // them. Read-only check (validatePilotToken does NOT mutate); the
  // atomic consume happens after user creation.
  if (pilotToken) {
    const v = await validatePilotToken(pilotToken)
    if (!v.ok) {
      await logEvent({
        name: 'pilot_redemption_failed',
        properties: { reason: v.reason, stage: 'pre-signup' },
      })
      return fail(
        'This pilot invite has already been used or has expired. Ask the team for a fresh link.',
        409,
      )
    }
  }

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (existing) {
    return fail('Email already registered', 409)
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const [newUser] = await db
    .insert(users)
    .values({ email, passwordHash, name })
    .returning({ id: users.id })

  const [newCustomer] = await db
    .insert(customers)
    .values({ userId: newUser.id })
    .returning({ id: customers.id })

  const ipAddress =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null
  await db.insert(legalAcceptances).values({
    userId: newUser.id,
    version: LEGAL_VERSION,
    ipAddress,
  })

  // Spec 31 — pilot redemption. We already validated the token above
  // (read-only fail-fast before user creation). Now atomically consume
  // it. The only reason this can return null AT THIS POINT is a race
  // with another concurrent register that consumed the token between
  // our pre-validate and here — extremely rare in practice.
  let pilotRedeemed = false
  if (pilotToken) {
    const tokenId = await consumePilotToken(pilotToken)
    if (tokenId) {
      await db
        .update(customers)
        .set({ pilotUntil: sql`now() + interval '${sql.raw(String(PILOT_DURATION_DAYS))} days'` })
        .where(eq(customers.id, newCustomer.id))
      await db
        .update(pilotTokens)
        .set({ usedByUserId: newUser.id })
        .where(eq(pilotTokens.id, tokenId))
      await logEvent({
        name: 'pilot_redeemed',
        userId: newUser.id,
        customerId: newCustomer.id,
        properties: { tokenId },
      })
      pilotRedeemed = true
    } else {
      // Race — token was valid at pre-check but consumed in the window.
      // Account already exists, so we keep the registration successful;
      // ops can manually flag pilot_until in psql if needed. Distinct
      // event name from the pre-signup case so funnel analysis stays clean.
      await logEvent({
        name: 'pilot_redemption_failed_race',
        userId: newUser.id,
        customerId: newCustomer.id,
        properties: { reason: 'consumed-by-other-during-signup' },
      })
    }
  }

  // Spec 30 — close the funnel-analytics loop. Pair with
  // `onboarding_stripe_viewed` and `oauth_completed` to reconstruct
  // register → view-onboarding → connect drop-off.
  await logEvent({
    name: 'register_completed',
    userId: newUser.id,
    properties: { hasName: !!name, pilotRedeemed },
  })

  if (isFormPost) {
    return NextResponse.redirect(`${publicOrigin()}/login`, 303)
  }
  return NextResponse.json({ success: true }, { status: 201 })
}
