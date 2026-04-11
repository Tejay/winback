import { NextResponse } from 'next/server'
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'
import { users, customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

const registerSchema = z.object({
  name:     z.string().min(1, 'Name is required'),
  email:    z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export async function POST(req: Request) {
  const body = await req.json()
  const parsed = registerSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 }
    )
  }

  const { name, email, password } = parsed.data

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (existing) {
    return NextResponse.json(
      { error: 'Email already registered' },
      { status: 409 }
    )
  }

  const passwordHash = await bcrypt.hash(password, 12)

  const [newUser] = await db
    .insert(users)
    .values({ email, passwordHash, name })
    .returning({ id: users.id })

  await db.insert(customers).values({ userId: newUser.id })

  return NextResponse.json({ success: true }, { status: 201 })
}
