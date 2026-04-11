import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { encrypt } from '@/src/winback/lib/encryption'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl

  const error = searchParams.get('error')
  if (error) {
    return NextResponse.redirect(
      new URL('/onboarding/gmail?error=denied', req.url)
    )
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (!code || !state) {
    return NextResponse.redirect(
      new URL('/onboarding/gmail?error=missing_params', req.url)
    )
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, state))
    .limit(1)

  if (!customer) {
    return NextResponse.redirect(
      new URL('/onboarding/gmail?error=invalid_state', req.url)
    )
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GMAIL_CLIENT_ID!,
      client_secret: process.env.GMAIL_CLIENT_SECRET!,
      redirect_uri: process.env.GMAIL_REDIRECT_URI!,
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    return NextResponse.redirect(
      new URL('/onboarding/gmail?error=token_exchange_failed', req.url)
    )
  }

  const tokenData = await tokenRes.json()

  const userInfoRes = await fetch('https://www.googleapis.com/userinfo/v2/me', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  })
  const userInfo = await userInfoRes.json()

  await db
    .update(customers)
    .set({
      gmailRefreshToken: encrypt(tokenData.refresh_token),
      gmailEmail: userInfo.email,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, state))

  return NextResponse.redirect(new URL('/onboarding/changelog', req.url))
}
