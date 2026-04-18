import { createHmac, timingSafeEqual } from 'crypto'

/**
 * HMAC-signed tokens for subscriber-facing one-time links (unsubscribe,
 * tier chooser, etc.). Different `purpose` values produce different tokens
 * so a token signed for one purpose can't be replayed against another.
 */

function getSecret(): string {
  const secret = process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error('NEXTAUTH_SECRET is not set')
  return secret
}

function sign(subscriberId: string, purpose: string): string {
  return createHmac('sha256', getSecret())
    .update(`${purpose}:${subscriberId}`)
    .digest('base64url')
}

export function signSubscriberToken(subscriberId: string, purpose: string): string {
  return sign(subscriberId, purpose)
}

export function verifySubscriberToken(
  subscriberId: string,
  purpose: string,
  token: string | null | undefined,
): boolean {
  if (!token) return false
  const expected = sign(subscriberId, purpose)
  const a = Buffer.from(expected)
  const b = Buffer.from(token)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

// Backwards-compatible aliases — existing unsubscribe links use these.
// The 'unsubscribe' purpose matches the original implementation's signing
// payload, so previously-issued tokens remain valid.
export function generateUnsubscribeToken(subscriberId: string): string {
  return signSubscriberToken(subscriberId, 'unsubscribe')
}

export function verifyUnsubscribeToken(subscriberId: string, token: string | null | undefined): boolean {
  return verifySubscriberToken(subscriberId, 'unsubscribe', token)
}
