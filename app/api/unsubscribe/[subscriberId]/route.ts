import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { verifyUnsubscribeToken } from '@/src/winback/lib/unsubscribe-token'
import { logEvent } from '@/src/winback/lib/events'

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
    .set({
      doNotContact: true,
      unsubscribedAt: new Date(),
      // Spec 21b — also resolve any pending handoff
      founderHandoffResolvedAt: sql`COALESCE(${churnedSubscribers.founderHandoffResolvedAt}, CASE WHEN ${churnedSubscribers.founderHandoffAt} IS NOT NULL THEN now() ELSE NULL END)`,
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'subscriber_unsubscribed',
    properties: { subscriberId, method: 'html' },
  })

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
    .set({
      doNotContact: true,
      unsubscribedAt: new Date(),
      // Spec 21b — also resolve any pending handoff
      founderHandoffResolvedAt: sql`COALESCE(${churnedSubscribers.founderHandoffResolvedAt}, CASE WHEN ${churnedSubscribers.founderHandoffAt} IS NOT NULL THEN now() ELSE NULL END)`,
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'subscriber_unsubscribed',
    properties: { subscriberId, method: 'one_click' },
  })

  return new NextResponse('Unsubscribed', { status: 200 })
}
