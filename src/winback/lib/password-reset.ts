/**
 * Spec 29 — Password reset token helpers.
 *
 * Raw tokens are 256-bit url-safe random strings. The DB only stores
 * sha256(raw) so DB read alone cannot mint a valid reset link. The raw
 * token lives only in the email URL and the user's address bar.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { passwordResetTokens, users } from '@/lib/schema'
import { and, eq, gt, isNull } from 'drizzle-orm'

export const TOKEN_TTL_MINUTES = 60

export function generateRawToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export type ValidatedToken = {
  ok: true
  tokenId: string
  userId: string
}

export type InvalidToken = {
  ok: false
  reason: 'not-found' | 'used' | 'expired'
}

/**
 * Look up a raw token. Read-only — does NOT mark used. Used by the
 * /reset-password page to decide whether to render the form or the
 * "expired link" error card.
 */
export async function validateResetToken(
  raw: string,
): Promise<ValidatedToken | InvalidToken> {
  if (!raw) return { ok: false, reason: 'not-found' }

  const tokenHash = hashToken(raw)
  const [row] = await db
    .select({
      id:        passwordResetTokens.id,
      userId:    passwordResetTokens.userId,
      usedAt:    passwordResetTokens.usedAt,
      expiresAt: passwordResetTokens.expiresAt,
    })
    .from(passwordResetTokens)
    .where(eq(passwordResetTokens.tokenHash, tokenHash))
    .limit(1)

  if (!row) return { ok: false, reason: 'not-found' }
  if (row.usedAt) return { ok: false, reason: 'used' }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, tokenId: row.id, userId: row.userId }
}

/**
 * Atomically marks a token used and returns its userId, OR returns null if
 * the token is no longer valid (race / replay). Caller does the password
 * update separately — kept atomic via the conditional UPDATE here so two
 * concurrent /reset-password POSTs can't both succeed.
 */
export async function consumeResetToken(raw: string): Promise<string | null> {
  if (!raw) return null
  const tokenHash = hashToken(raw)
  const now = new Date()
  const [row] = await db
    .update(passwordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, now),
      ),
    )
    .returning({ userId: passwordResetTokens.userId })
  return row?.userId ?? null
}

/**
 * Issues a new reset token for the given user. Invalidates any prior
 * unused tokens for that user so a stale link from an earlier request
 * can't be used after the founder asked for a new one.
 *
 * Returns the raw token (caller emails it). The hash is what hits the DB.
 */
export async function issueResetToken(opts: {
  userId: string
  ipAddress: string | null
}): Promise<string> {
  const { userId, ipAddress } = opts
  const raw = generateRawToken()
  const tokenHash = hashToken(raw)
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60_000)

  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.userId, userId),
        isNull(passwordResetTokens.usedAt),
      ),
    )

  await db.insert(passwordResetTokens).values({
    userId,
    tokenHash,
    expiresAt,
    ipAddress,
  })

  return raw
}

/**
 * Counts how many reset tokens have been issued for this user in the last
 * `windowMs` ms. Used to rate-limit /api/auth/forgot-password.
 */
export async function recentTokenCount(opts: {
  userId: string
  windowMs: number
}): Promise<number> {
  const { userId, windowMs } = opts
  const since = new Date(Date.now() - windowMs)
  const rows = await db
    .select({ id: passwordResetTokens.id })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.userId, userId),
        gt(passwordResetTokens.createdAt, since),
      ),
    )
  return rows.length
}

export async function findUserIdByEmail(email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  return row?.id ?? null
}
