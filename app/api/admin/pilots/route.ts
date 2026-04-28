import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { customers, users, pilotTokens } from '@/lib/schema'
import { and, eq, isNotNull, isNull, sql, desc } from 'drizzle-orm'
import { PILOT_CAP } from '@/src/winback/lib/pilot'

/**
 * GET /api/admin/pilots
 *
 * Spec 31 — list of active pilots (redeemed + still in their 30-day window)
 * AND outstanding tokens (issued but not yet redeemed). Both count toward
 * the PILOT_CAP slot budget.
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const ro = getDbReadOnly()

  const activePilots = await ro
    .select({
      customerId:  customers.id,
      email:       users.email,
      founderName: customers.founderName,
      pilotUntil:  customers.pilotUntil,
      pilotEndingWarnedAt: customers.pilotEndingWarnedAt,
      stripeConnected:     sql<boolean>`${customers.stripeAccessToken} is not null`,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(
      and(
        isNotNull(customers.pilotUntil),
        sql`${customers.pilotUntil} > now()`,
      ),
    )
    .orderBy(desc(customers.pilotUntil))

  const pendingTokens = await ro
    .select({
      tokenId:   pilotTokens.id,
      note:      pilotTokens.note,
      expiresAt: pilotTokens.expiresAt,
      createdAt: pilotTokens.createdAt,
      createdByEmail: users.email,
    })
    .from(pilotTokens)
    .leftJoin(users, eq(users.id, pilotTokens.createdByUserId))
    .where(
      and(
        isNull(pilotTokens.usedAt),
        sql`${pilotTokens.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(pilotTokens.createdAt))

  const slotsUsed = activePilots.length + pendingTokens.length

  return NextResponse.json({
    slotsUsed,
    capacity: PILOT_CAP,
    activePilots: activePilots.map((p) => ({
      customerId:  p.customerId,
      email:       p.email,
      founderName: p.founderName,
      pilotUntil:  p.pilotUntil?.toISOString() ?? null,
      daysRemaining: p.pilotUntil
        ? Math.max(0, Math.ceil((p.pilotUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null,
      headsUpSent:     p.pilotEndingWarnedAt !== null,
      stripeConnected: !!p.stripeConnected,
    })),
    pendingTokens: pendingTokens.map((t) => ({
      tokenId:   t.tokenId,
      note:      t.note,
      expiresAt: t.expiresAt.toISOString(),
      createdAt: t.createdAt.toISOString(),
      createdByEmail: t.createdByEmail,
    })),
  })
}
