import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { and, eq, desc, count } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

const MAX_ACTIVE_IMPROVEMENTS = 10

// Spec 73 — pagination defaults per code path.
// - status=published: returns ALL rows (no offset, no limit; bounded by
//   MAX_ACTIVE_IMPROVEMENTS = 10).
// - status=archived:  default pageSize 20.
// - status omitted:   default pageSize 50 (backwards compat with the
//   pre-spec-73 GET shape the tests used).
const DEFAULT_PAGE_SIZE_ARCHIVED = 20
const DEFAULT_PAGE_SIZE_ALL      = 50
const MAX_PAGE_SIZE              = 100

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

export async function GET(req?: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const customerId = await resolveCustomerId(session.user.id)
  if (!customerId) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  // Spec 73 — paginated GET.
  //   status=published → return all (≤10 by MAX_ACTIVE_IMPROVEMENTS cap)
  //   status=archived  → paginated, pageSize 20 default
  //   omitted          → paginated all rows, pageSize 50 default (back-compat)
  const searchParams = req ? new URL(req.url).searchParams : new URLSearchParams()
  const statusParam  = searchParams.get('status')

  const where = statusParam === 'published'
    ? and(eq(improvements.customerId, customerId), eq(improvements.status, 'published'))!
    : statusParam === 'archived'
      ? and(eq(improvements.customerId, customerId), eq(improvements.status, 'archived'))!
      : eq(improvements.customerId, customerId)

  // Published: skip pagination — bounded by MAX_ACTIVE_IMPROVEMENTS cap.
  if (statusParam === 'published') {
    const rows = await db
      .select()
      .from(improvements)
      .where(where)
      .orderBy(desc(improvements.dateShipped))
    return NextResponse.json({
      improvements: rows,
      total:        rows.length,
      page:         1,
      pageSize:     rows.length,
    })
  }

  // Archived + omitted: paginate.
  const defaultSize = statusParam === 'archived' ? DEFAULT_PAGE_SIZE_ARCHIVED : DEFAULT_PAGE_SIZE_ALL
  const rawPage     = Number.parseInt(searchParams.get('page')     ?? '1',                 10)
  const rawPageSize = Number.parseInt(searchParams.get('pageSize') ?? String(defaultSize), 10)
  const page     = Number.isFinite(rawPage)     && rawPage     >= 1 ? rawPage     : 1
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1
    ? Math.min(Math.max(rawPageSize, 1), MAX_PAGE_SIZE)
    : defaultSize

  const [rows, [totalRow]] = await Promise.all([
    db.select()
      .from(improvements)
      .where(where)
      .orderBy(desc(improvements.dateShipped))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() })
      .from(improvements)
      .where(where),
  ])

  return NextResponse.json({
    improvements: rows,
    total:        Number(totalRow?.n ?? 0),
    page,
    pageSize,
  })
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
