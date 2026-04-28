/**
 * Spec 32 — Email-verification token helpers.
 *
 * Token model mirrors Spec 29 password-reset:
 *   - 256-bit base64url raw token; only sha256 stored
 *   - 7-day TTL (longer than password-reset's 24h since it's a one-shot
 *     confirmation, not a sensitive recovery — slow-inbox founders
 *     shouldn't get locked out by an over-aggressive expiry)
 *   - Single-use via atomic conditional UPDATE
 *
 * Issuing always invalidates prior unused tokens for the same user, so
 * a stale link from an earlier signup or resend can't be used after the
 * founder asked for a new one.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { emailVerificationTokens, users } from '@/lib/schema'
import { and, eq, gt, isNull } from 'drizzle-orm'

export const VERIFY_TOKEN_TTL_DAYS = 7

export function generateRawToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export type ValidatedVerificationToken =
  | { ok: true; tokenId: string; userId: string }
  | { ok: false; reason: 'not-found' | 'used' | 'expired' }

/** Read-only check. Used by the /verify-email page to decide what to render. */
export async function validateVerificationToken(
  raw: string,
): Promise<ValidatedVerificationToken> {
  if (!raw) return { ok: false, reason: 'not-found' }
  const tokenHash = hashToken(raw)
  const [row] = await db
    .select({
      id:        emailVerificationTokens.id,
      userId:    emailVerificationTokens.userId,
      usedAt:    emailVerificationTokens.usedAt,
      expiresAt: emailVerificationTokens.expiresAt,
    })
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.tokenHash, tokenHash))
    .limit(1)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.usedAt) return { ok: false, reason: 'used' }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, tokenId: row.id, userId: row.userId }
}

/**
 * Atomically marks the token used and returns its userId, or null if the
 * token is no longer valid (race / replay). Caller separately marks the
 * user's email_verified_at — kept atomic via the conditional UPDATE here
 * so two concurrent clicks can't both succeed.
 */
export async function consumeVerificationToken(raw: string): Promise<string | null> {
  if (!raw) return null
  const tokenHash = hashToken(raw)
  const now = new Date()
  const [row] = await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailVerificationTokens.tokenHash, tokenHash),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, now),
      ),
    )
    .returning({ userId: emailVerificationTokens.userId })
  return row?.userId ?? null
}

/**
 * Issues a fresh verification token. Invalidates any prior unused tokens
 * for that user so a stale link from an earlier register/resend can't be
 * used after a more recent one was sent.
 */
export async function issueVerificationToken(opts: {
  userId: string
  ipAddress: string | null
}): Promise<string> {
  const { userId, ipAddress } = opts
  const raw = generateRawToken()
  const tokenHash = hashToken(raw)
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_DAYS * 24 * 60 * 60_000)

  await db
    .update(emailVerificationTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerificationTokens.userId, userId),
        isNull(emailVerificationTokens.usedAt),
      ),
    )

  await db.insert(emailVerificationTokens).values({
    userId,
    tokenHash,
    expiresAt,
    ipAddress,
  })

  return raw
}

/**
 * Marks the user as verified. Idempotent — safe to call again on an
 * already-verified user (the column has a non-null value, won't change).
 */
export async function markUserEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date() })
    .where(eq(users.id, userId))
}

/** Lookup helper — used by /api/auth/resend-verification. */
export async function findUserForResend(email: string): Promise<{
  id: string
  emailVerifiedAt: Date | null
} | null> {
  const [row] = await db
    .select({
      id:              users.id,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return row ?? null
}

/** Counts how many verification tokens have been issued for this user in
 *  the given window. Used to rate-limit /api/auth/resend-verification. */
export async function recentVerificationTokenCount(opts: {
  userId: string
  windowMs: number
}): Promise<number> {
  const { userId, windowMs } = opts
  const since = new Date(Date.now() - windowMs)
  const rows = await db
    .select({ id: emailVerificationTokens.id })
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.userId, userId),
        gt(emailVerificationTokens.createdAt, since),
      ),
    )
  return rows.length
}
