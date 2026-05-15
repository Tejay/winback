import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, improvements, improvementMatches } from '@/lib/schema'
import { and, eq, desc, count, sql } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

const MAX_ACTIVE_IMPROVEMENTS = 10

/**
 * Spec 65 Phase 2 — CRUD entrypoint for Winback Reasons.
 *
 * GET  /api/improvements           — list all (published + archived) for
 *                                    the calling merchant's customer.
 * POST /api/improvements           — create a new improvement (status:
 *                                    'published'). Enforces:
 *                                      - title 4–120 chars
 *                                      - description 1–500 chars
 *                                      - dateShipped ≤ today
 *                                      - active-count cap of 10
 *                                    DB CHECK constraints back-stop these.
 *
 * Server-side AI quality classification (block/warn for junk/abstract
 * content) is a Phase 3 add-on. Today the API trusts well-formed input
 * after the structural checks above.
 */

const createSchema = z.object({
  title:            z.string().trim().min(4).max(120),
  description:      z.string().trim().min(1).max(500),
  dateShipped:      z.string()
                     .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
                     .refine((d) => new Date(d) <= new Date(), 'dateShipped cannot be in the future'),
  addressesPattern: z.string().max(200).nullable().optional(),
  preempted:        z.boolean().optional().default(false),
})

async function resolveCustomerId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, userId))
    .limit(1)
  return row?.id ?? null
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const customerId = await resolveCustomerId(session.user.id)
  if (!customerId) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  // Spec 75 — include matchedCount per row so the merchant UI can show
  // "Matched: N customers" on each active reason. Single LEFT JOIN +
  // COUNT subquery on wb_improvement_matches, no N+1.
  const rows = await db
    .select({
      id:               improvements.id,
      customerId:       improvements.customerId,
      title:            improvements.title,
      description:      improvements.description,
      dateShipped:      improvements.dateShipped,
      status:           improvements.status,
      addressesPattern: improvements.addressesPattern,
      preempted:        improvements.preempted,
      createdAt:        improvements.createdAt,
      archivedAt:       improvements.archivedAt,
      updatedAt:        improvements.updatedAt,
      matchedCount:     sql<number>`COALESCE(COUNT(${improvementMatches.improvementId}), 0)::int`,
    })
    .from(improvements)
    .leftJoin(improvementMatches, eq(improvementMatches.improvementId, improvements.id))
    .where(eq(improvements.customerId, customerId))
    .groupBy(improvements.id)
    .orderBy(desc(improvements.dateShipped))

  return NextResponse.json({ improvements: rows })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const customerId = await resolveCustomerId(session.user.id)
  if (!customerId) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const [{ active } = { active: 0 }] = await db
    .select({ active: count() })
    .from(improvements)
    .where(and(eq(improvements.customerId, customerId), eq(improvements.status, 'published')))

  if (active >= MAX_ACTIVE_IMPROVEMENTS) {
    return NextResponse.json(
      { error: `You have ${MAX_ACTIVE_IMPROVEMENTS} active improvements. Archive one to add a new one.` },
      { status: 409 },
    )
  }

  const [row] = await db
    .insert(improvements)
    .values({
      customerId,
      title:            parsed.data.title,
      description:      parsed.data.description,
      dateShipped:      parsed.data.dateShipped,  // YYYY-MM-DD string, Drizzle date column
      addressesPattern: parsed.data.addressesPattern ?? null,
      preempted:        parsed.data.preempted ?? !parsed.data.addressesPattern,
    })
    .returning()

  await logEvent({
    name: 'improvement_published',
    customerId,
    properties: {
      improvementId:    row.id,
      title:            row.title,
      addressesPattern: row.addressesPattern,
      preempted:        row.preempted,
    },
  })

  return NextResponse.json({ improvement: row }, { status: 201 })
}
