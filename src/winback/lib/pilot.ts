/**
 * Spec 31 — Pilot-program helpers.
 *
 * Token model mirrors Spec 29 password-reset:
 *   - 256-bit base64url raw token; only sha256 stored
 *   - 14-day TTL on the token (separate from the 30-day pilot duration)
 *   - Single-use via atomic conditional UPDATE
 *
 * Bypass gate `isCustomerOnPilot` is the single source of truth used by
 * `ensurePlatformSubscription` and `chargePerformanceFee` to skip billing
 * while `wb_customers.pilot_until > now()`.
 *
 * Cron pass `runPilotEndingWarnings` is wired into the daily
 * /api/cron/onboarding-followup as a 4th pass. Sends the Day-23 heads-up
 * email exactly once via `pilot_ending_warned_at` idempotency.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { customers, pilotTokens, users } from '@/lib/schema'
import { and, eq, gt, isNull, isNotNull, sql } from 'drizzle-orm'
import { sendPilotEndingSoonEmail } from './email'
import { logEvent } from './events'

/** 14 days. Token validity from issue → redemption. */
export const PILOT_TOKEN_TTL_DAYS = 14
/** 30 days. Pilot duration from redemption → graduation. */
export const PILOT_DURATION_DAYS = 30
/** Hard cap on simultaneous active-or-pending pilots. */
export const PILOT_CAP = 10
/** Send the heads-up when pilot_until is roughly 7 days out (±1d). */
const HEADS_UP_LIMIT = 50

export function generateRawToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export type ValidatedPilotToken =
  | { ok: true; tokenId: string }
  | { ok: false; reason: 'not-found' | 'used' | 'expired' }

export async function validatePilotToken(raw: string): Promise<ValidatedPilotToken> {
  if (!raw) return { ok: false, reason: 'not-found' }
  const tokenHash = hashToken(raw)
  const [row] = await db
    .select({
      id:        pilotTokens.id,
      usedAt:    pilotTokens.usedAt,
      expiresAt: pilotTokens.expiresAt,
    })
    .from(pilotTokens)
    .where(eq(pilotTokens.tokenHash, tokenHash))
    .limit(1)
  if (!row) return { ok: false, reason: 'not-found' }
  if (row.usedAt) return { ok: false, reason: 'used' }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, tokenId: row.id }
}

/**
 * Atomically marks the token as used. Returns the tokenId on success or
 * null if the token is no longer valid (race / replay). Caller wires the
 * pilot_until update + used_by_user_id update separately.
 */
export async function consumePilotToken(raw: string): Promise<string | null> {
  if (!raw) return null
  const tokenHash = hashToken(raw)
  const now = new Date()
  const [row] = await db
    .update(pilotTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(pilotTokens.tokenHash, tokenHash),
        isNull(pilotTokens.usedAt),
        gt(pilotTokens.expiresAt, now),
      ),
    )
    .returning({ id: pilotTokens.id })
  return row?.id ?? null
}

export async function issuePilotToken(opts: {
  note?: string | null
  createdByUserId: string
}): Promise<{ rawToken: string; tokenId: string; expiresAt: Date }> {
  const rawToken = generateRawToken()
  const tokenHash = hashToken(rawToken)
  const expiresAt = new Date(Date.now() + PILOT_TOKEN_TTL_DAYS * 24 * 60 * 60_000)
  const [row] = await db
    .insert(pilotTokens)
    .values({
      tokenHash,
      expiresAt,
      note:            opts.note ?? null,
      createdByUserId: opts.createdByUserId,
    })
    .returning({ id: pilotTokens.id })
  return { rawToken, tokenId: row.id, expiresAt }
}

/** Single-row gate read by activation + perf-fee bypass paths. */
export async function isCustomerOnPilot(customerId: string): Promise<boolean> {
  if (!customerId) return false
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.id, customerId),
        isNotNull(customers.pilotUntil),
        sql`${customers.pilotUntil} > now()`,
      ),
    )
    .limit(1)
  return !!row
}

/** Returns `pilot_until` if set (regardless of whether it's in the future). */
export async function getPilotUntil(customerId: string): Promise<Date | null> {
  if (!customerId) return null
  const [row] = await db
    .select({ pilotUntil: customers.pilotUntil })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  return row?.pilotUntil ?? null
}

/**
 * Counts the slots used toward PILOT_CAP. A slot is held by:
 *   - any customer whose pilot_until > now() (redeemed, active)
 *   - any pilot token that's unused AND unexpired (issued, pending)
 *
 * Operationally: a freshly issued token holds a slot until the founder
 * redeems it, the 14-day TTL expires, or someone manually marks it used.
 */
export async function countPilotSlotsUsed(): Promise<number> {
  const [activeRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(customers)
    .where(
      and(
        isNotNull(customers.pilotUntil),
        sql`${customers.pilotUntil} > now()`,
      ),
    )
  const [pendingRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(pilotTokens)
    .where(
      and(
        isNull(pilotTokens.usedAt),
        sql`${pilotTokens.expiresAt} > now()`,
      ),
    )
  return (activeRow?.c ?? 0) + (pendingRow?.c ?? 0)
}

/**
 * Cron pass — Day-23 heads-up email. Eligibility: pilot_until is 6-8 days
 * out (±1 day from the 7-day target so a missed cron tick doesn't
 * permanently skip a pilot) AND not already warned.
 */
export async function runPilotEndingWarnings(opts: {
  dryRun: boolean
}): Promise<{ processed: number; sent: number; errors: number }> {
  const { dryRun } = opts

  const rows = await db
    .select({
      customerId:  customers.id,
      userId:      users.id,
      email:       users.email,
      founderName: customers.founderName,
      pilotUntil:  customers.pilotUntil,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(
      and(
        isNotNull(customers.pilotUntil),
        isNull(customers.pilotEndingWarnedAt),
        eq(users.isAdmin, false),
        sql`${customers.pilotUntil} BETWEEN now() + interval '6 days' AND now() + interval '8 days'`,
      ),
    )
    .limit(HEADS_UP_LIMIT)

  let sent = 0
  let errors = 0

  for (const row of rows) {
    try {
      if (!row.pilotUntil) continue

      if (dryRun) {
        sent++
        continue
      }

      await sendPilotEndingSoonEmail({
        to:          row.email,
        founderName: row.founderName,
        endsOn:      row.pilotUntil,
      })

      await db
        .update(customers)
        .set({ pilotEndingWarnedAt: new Date() })
        .where(eq(customers.id, row.customerId))

      await logEvent({
        name:       'pilot_ending_soon_sent',
        customerId: row.customerId,
        userId:     row.userId,
        properties: { pilotUntil: row.pilotUntil.toISOString() },
      })

      sent++
    } catch (err) {
      errors++
      console.error('[pilot] heads-up error for', row.email, err)
    }
  }

  return { processed: rows.length, sent, errors }
}
