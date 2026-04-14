import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { verifyUnsubscribeToken } from '@/src/winback/lib/unsubscribe-token'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ subscriberId: string }> }
) {
  const { subscriberId } = await params
  const token = req.nextUrl.searchParams.get('t')
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? 'https://winbackflow.co'

  if (!verifyUnsubscribeToken(subscriberId, token)) {
    return new NextResponse('Invalid unsubscribe link', { status: 400 })
  }

  await db
    .update(churnedSubscribers)
    .set({ doNotContact: true, unsubscribedAt: new Date(), updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  return NextResponse.redirect(`${baseUrl}/unsubscribed`)
}

// Gmail / Apple Mail one-click unsubscribe (List-Unsubscribe-Post header)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ subscriberId: string }> }
) {
  const { subscriberId } = await params
  const token = req.nextUrl.searchParams.get('t')

  if (!verifyUnsubscribeToken(subscriberId, token)) {
    return new NextResponse('Invalid unsubscribe link', { status: 400 })
  }

  await db
    .update(churnedSubscribers)
    .set({ doNotContact: true, unsubscribedAt: new Date(), updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  return new NextResponse('Unsubscribed', { status: 200 })
}
