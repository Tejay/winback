/**
 * Spec 73 — /api/subscribers offset pagination tests.
 *
 * Covers:
 *  - default page/pageSize when params are omitted
 *  - pageSize clamp to [1, 100]
 *  - page < 1 clamped to 1
 *  - page out of range returns empty rows with correct total
 *  - response shape: { rows, total, page, pageSize }
 *
 * Each test mocks two queries: the SELECT (rows) and the COUNT (total).
 * The route runs them via Promise.all so order of mock returns matters —
 * SELECT first, then COUNT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockAuth   = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  customers:          { id: 'customer_id', userId: 'user_id' },
  churnedSubscribers: {
    customerId:           'customer_id',
    cancellationReason:   'cancellation_reason',
    nextPaymentAttemptAt: 'next_payment_attempt_at',
    cancelledAt:          'cancelled_at',
    founderHandoffAt:     'founder_handoff_at',
    founderHandoffResolvedAt: 'founder_handoff_resolved_at',
    name:                 'name',
    email:                'email',
    status:               'status',
    dunningState:         'dunning_state',
    id:                   'id',
  },
  emailsSent: {
    subscriberId: 'subscriber_id',
    repliedAt:    'replied_at',
  },
  subscriberReplies: {
    subscriberId: 'subscriber_id',
    body:         'body',
    receivedAt:   'received_at',
  },
  // Spec 78 — referenced by the applied-promotion-chip lookup added
  // after the main SELECT/COUNT. The test mock just needs symbolic
  // identifiers; the chain is fully mocked via selectChain.
  recoveries: {
    subscriberId:           'subscriber_id',
    appliedPromotionCodeId: 'applied_promotion_code_id',
  },
  improvements: {
    id:                'id',
    promotionMetadata: 'promotion_metadata',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq:        vi.fn((a, b) => ({ op: 'eq', a, b })),
  and:       vi.fn((...c) => ({ op: 'and', c })),
  or:        vi.fn((...c) => ({ op: 'or', c })),
  ne:        vi.fn((a, b) => ({ op: 'ne', a, b })),
  isNull:    vi.fn((c) => ({ op: 'isNull', c })),
  isNotNull: vi.fn((c) => ({ op: 'isNotNull', c })),
  inArray:   vi.fn((c, vs) => ({ op: 'inArray', c, vs })),
  ilike:     vi.fn((a, b) => ({ op: 'ilike', a, b })),
  desc:      vi.fn((c) => ({ op: 'desc', c })),
  count:     vi.fn(() => 'count_marker'),
  getTableColumns: vi.fn(() => ({})),
  sql:       Object.assign(
    (..._args: unknown[]) => ({ op: 'sql', as: (_n?: string) => ({ op: 'sql' }) }),
    { raw: (s: string) => s },
  ),
}))

vi.mock('@/lib/auth', () => ({ auth: mockAuth }))
vi.mock('@/lib/ai-state', () => ({
  aiStateFilterCondition: vi.fn(() => null),
  isValidAiStateFilter:   vi.fn(() => false),
  awaitingReplyExpr:      vi.fn(() => ({ as: (_n?: string) => ({ op: 'sql' }) })),
}))
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}))

import { GET } from '@/app/api/subscribers/route'

// Drizzle chain helper. SELECT chain: from → where → orderBy → limit → offset
// (terminal, awaitable). COUNT chain: from → where (terminal, awaitable).
// Spec 78 — promo-lookup chain adds .leftJoin between .from and .where.
function selectChain(rows: unknown[]) {
  const step: { then: unknown; orderBy: unknown; limit: unknown; offset: unknown; from: unknown; where: unknown; leftJoin: unknown } = {
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    orderBy:  vi.fn(),
    limit:    vi.fn(),
    offset:   vi.fn(),
    from:     vi.fn(),
    where:    vi.fn(),
    leftJoin: vi.fn(),
  }
  ;(step.orderBy  as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.limit    as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.offset   as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.from     as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.where    as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.leftJoin as ReturnType<typeof vi.fn>).mockReturnValue(step)
  return step
}

function customerLookup(customerId: string | null) {
  return selectChain(customerId ? [{ id: customerId }] : [])
}

// The route reads `req.nextUrl.searchParams` (NextRequest shape). For
// unit tests we don't need the full Next runtime — a URL has the same
// `.searchParams` getter, so we wrap it as `{ nextUrl: URL }`.
function makeReq(qs = ''): { nextUrl: URL } {
  return { nextUrl: new URL(`http://localhost/api/subscribers${qs}`) }
}

beforeEach(() => {
  vi.resetAllMocks()
  mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
})

describe('GET /api/subscribers — Spec 73 pagination', () => {
  it('uses default page=1 and pageSize=25 when params are omitted', async () => {
    const rows = [{ id: 'sub_1' }, { id: 'sub_2' }]
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))     // resolveCustomer
      .mockReturnValueOnce(selectChain(rows))            // SELECT
      .mockReturnValueOnce(selectChain([{ n: 2 }]))      // COUNT
      .mockReturnValueOnce(selectChain([]))              // Spec 78 promo lookup

    const res = await GET(makeReq() as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { rows: unknown[]; total: number; page: number; pageSize: number }
    expect(body.page).toBe(1)
    expect(body.pageSize).toBe(25)
    expect(body.total).toBe(2)
    expect(body.rows).toHaveLength(2)
  })

  it('clamps pageSize > 100 down to 100', async () => {
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]))

    const res = await GET(makeReq('?pageSize=500') as never)
    const body = await res.json() as { pageSize: number }
    expect(body.pageSize).toBe(100)
  })

  it('clamps pageSize < 1 up to the default', async () => {
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]))

    const res = await GET(makeReq('?pageSize=0') as never)
    const body = await res.json() as { pageSize: number }
    // 0 fails the `>= 1` guard, so default (25) is used.
    expect(body.pageSize).toBe(25)
  })

  it('clamps page < 1 to 1', async () => {
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]))

    const res = await GET(makeReq('?page=-5') as never)
    const body = await res.json() as { page: number }
    expect(body.page).toBe(1)
  })

  it('echoes a valid pageSize (e.g. 50) without clamping', async () => {
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]))

    const res = await GET(makeReq('?pageSize=50') as never)
    const body = await res.json() as { pageSize: number }
    expect(body.pageSize).toBe(50)
  })

  it('page out of range: returns empty rows with the real total', async () => {
    // Server is asked for page 999 of a 40-row result set. SELECT returns
    // empty (the SQL offset is past the end), but COUNT returns 40 — so
    // the client can show "you're on page 999, there are only 2 pages"
    // and let the user navigate back.
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(selectChain([]))             // SELECT — empty
      .mockReturnValueOnce(selectChain([{ n: 40 }]))    // COUNT — real total

    const res = await GET(makeReq('?page=999&pageSize=25') as never)
    const body = await res.json() as { rows: unknown[]; total: number; page: number }
    expect(body.rows).toHaveLength(0)
    expect(body.total).toBe(40)
    expect(body.page).toBe(999)  // NOT auto-clamped on server — client handles UX
  })

  it('returns rows + total when page is in range', async () => {
    const rows = [{ id: 'sub_1' }, { id: 'sub_2' }, { id: 'sub_3' }]
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(selectChain(rows))
      .mockReturnValueOnce(selectChain([{ n: 73 }]))
      .mockReturnValueOnce(selectChain([]))               // Spec 78 promo lookup

    const res = await GET(makeReq('?page=2&pageSize=3') as never)
    const body = await res.json() as { rows: unknown[]; total: number; page: number; pageSize: number }
    expect(body.rows).toHaveLength(3)
    expect(body.total).toBe(73)
    expect(body.page).toBe(2)
    expect(body.pageSize).toBe(3)
  })

  it('rejects unauthenticated', async () => {
    mockAuth.mockResolvedValue(null)
    const res = await GET(makeReq() as never)
    expect(res.status).toBe(401)
  })

  it('404s when the customer row is missing', async () => {
    mockSelect.mockReturnValueOnce(customerLookup(null))
    const res = await GET(makeReq() as never)
    expect(res.status).toBe(404)
  })
})
