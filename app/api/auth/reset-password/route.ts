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
})

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    )
  }

  const { token, password } = parsed.data

  const userId = await consumeResetToken(token)
  if (!userId) {
    await logEvent({
      name: 'password_reset_invalid',
      properties: {},
    })
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

  return NextResponse.json({ ok: true })
}
