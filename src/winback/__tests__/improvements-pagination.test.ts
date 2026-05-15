/**
 * Spec 73 — /api/improvements pagination tests.
 *
 * Three code paths under one route:
 *   - status=published  → all rows, no offset (capped at 10 by MAX_ACTIVE)
 *   - status=archived   → paginated, default pageSize 20
 *   - status omitted    → paginated all rows, default pageSize 50 (back-compat)
 *
 * Each paginated path runs SELECT + COUNT in parallel; the published path
 * runs a single SELECT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockAuth   = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  customers:    { id: 'customer_id', userId: 'user_id' },
  improvements: {
    id: 'id',
    customerId: 'customer_id',
    title: 'title',
    description: 'description',
    dateShipped: 'date_shipped',
    status: 'status',
    addressesPattern: 'addresses_pattern',
    preempted: 'preempted',
    createdAt: 'created_at',
    archivedAt: 'archived_at',
    updatedAt: 'updated_at',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq:    vi.fn((a, b) => ({ op: 'eq', a, b })),
  and:   vi.fn((...c) => ({ op: 'and', c })),
  desc:  vi.fn((c) => ({ op: 'desc', c })),
  count: vi.fn(() => 'count_marker'),
}))

vi.mock('@/lib/auth', () => ({ auth: mockAuth }))
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}))

const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('@/src/winback/lib/events', () => ({ logEvent: mockLogEvent }))

import { GET } from '@/app/api/improvements/route'

function selectChain(rows: unknown[]) {
  const step: { then: unknown; orderBy: unknown; limit: unknown; offset: unknown; from: unknown; where: unknown } = {
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    orderBy: vi.fn(),
    limit:   vi.fn(),
    offset:  vi.fn(),
    from:    vi.fn(),
    where:   vi.fn(),
  }
  ;(step.orderBy as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.limit   as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.offset  as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.from    as ReturnType<typeof vi.fn>).mockReturnValue(step)
  ;(step.where   as ReturnType<typeof vi.fn>).mockReturnValue(step)
  return step
}

function customerLookup(customerId: string | null) {
  return selectChain(customerId ? [{ id: customerId }] : [])
}

function makeReq(qs = ''): Request {
  return new Request(`http://localhost/api/improvements${qs}`)
}

beforeEach(() => {
  vi.resetAllMocks()
  mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
})

describe('GET /api/improvements — Spec 73', () => {
  describe('status=published (single-query, no pagination)', () => {
    it('returns all published rows with total = rows.length', async () => {
      const rows = [{ id: 'imp_1' }, { id: 'imp_2' }, { id: 'imp_3' }]
      mockSelect
        .mockReturnValueOnce(customerLookup('cust_1'))
        .mockReturnValueOnce(selectChain(rows))  // single SELECT, no COUNT

      const res = await GET(makeReq('?status=published'))
      expect(res.status).toBe(200)
      const body = await res.json() as { improvements: unknown[]; total: number; page: number; pageSize: number }
      expect(body.improvements).toHaveLength(3)
      expect(body.total).toBe(3)
      expect(body.page).toBe(1)
      expect(body.pageSize).toBe(3)  // pageSize echoes count for the no-pagination path
    })
  })

  describe('status=archived (paginated, default pageSize 20)', () => {
    it('returns paginated archived rows + total', async () => {
      const rows = Array.from({ length: 20 }, (_, i) => ({ id: `arch_${i}` }))
      mockSelect
        .mockReturnValueOnce(customerLookup('cust_1'))
        .mockReturnValueOnce(selectChain(rows))           // SELECT
        .mockReturnValueOnce(selectChain([{ n: 47 }]))    // COUNT

      const res = await GET(makeReq('?status=archived'))
      const body = await res.json() as { improvements: unknown[]; total: number; page: number; pageSize: number }
      expect(body.improvements).toHaveLength(20)
      expect(body.total).toBe(47)
      expect(body.page).toBe(1)
      expect(body.pageSize).toBe(20)  // archived default
    })

    it('honors explicit page + pageSize', async () => {
      mockSelect
        .mockReturnValueOnce(customerLookup('cust_1'))
        .mockReturnValueOnce(selectChain([{ id: 'arch_x' }]))
        .mockReturnValueOnce(selectChain([{ n: 47 }]))

      const res = await GET(makeReq('?status=archived&page=3&pageSize=5'))
      const body = await res.json() as { page: number; pageSize: number }
      expect(body.page).toBe(3)
      expect(body.pageSize).toBe(5)
    })

    it('page out of range returns empty rows with real total', async () => {
      mockSelect
        .mockReturnValueOnce(customerLookup('cust_1'))
        .mockReturnValueOnce(selectChain([]))             // empty
        .mockReturnValueOnce(selectChain([{ n: 47 }]))    // real total

      const res = await GET(makeReq('?status=archived&page=99&pageSize=20'))
      const body = await res.json() as { improvements: unknown[]; total: number; page: number }
      expect(body.improvements).toHaveLength(0)
      expect(body.total).toBe(47)
      expect(body.page).toBe(99)
    })

    it('clamps pageSize > 100 to 100', async () => {
      mockSelect
        .mockReturnValueOnce(customerLookup('cust_1'))
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([{ n: 0 }]))

      const res = await GET(makeReq('?status=archived&pageSize=500'))
      const body = await res.json() as { pageSize: number }
      expect(body.pageSize).toBe(100)
    })
  })

  describe('status omitted (paginated, default pageSize 50, back-compat)', () => {
    it('defaults to pageSize=50 when status omitted', async () => {
      mockSelect
        .mockReturnValueOnce(customerLookup('cust_1'))
        .mockReturnValueOnce(selectChain([]))
        .mockReturnValueOnce(selectChain([{ n: 12 }]))

      const res = await GET(makeReq())
      const body = await res.json() as { pageSize: number; page: number; total: number }
      expect(body.pageSize).toBe(50)
      expect(body.page).toBe(1)
      expect(body.total).toBe(12)
    })
  })

  describe('auth + customer guards', () => {
    it('rejects unauthenticated', async () => {
      mockAuth.mockResolvedValue(null)
      const res = await GET(makeReq('?status=published'))
      expect(res.status).toBe(401)
    })

    it('404s when customer row is missing', async () => {
      mockSelect.mockReturnValueOnce(customerLookup(null))
      const res = await GET(makeReq('?status=published'))
      expect(res.status).toBe(404)
    })
  })
})
