import { createHmac, timingSafeEqual } from 'crypto'

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set')
  return secret
}

function sign(subscriberId: string): string {
  return createHmac('sha256', getSecret())
    .update(`unsubscribe:${subscriberId}`)
    .digest('base64url')
}

export function generateUnsubscribeToken(subscriberId: string): string {
  return sign(subscriberId)
}

export function verifyUnsubscribeToken(subscriberId: string, token: string | null | undefined): boolean {
  if (!token) return false
  const expected = sign(subscriberId)
  const a = Buffer.from(expected)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
