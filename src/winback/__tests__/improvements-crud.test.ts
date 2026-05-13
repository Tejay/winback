import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Spec 65 Phase 2 — improvements CRUD API tests.
 *
 * Covers the 4 endpoints under /api/improvements:
 *   GET    /api/improvements
 *   POST   /api/improvements
 *   PATCH  /api/improvements/[id]
 *   POST   /api/improvements/[id]/archive
 *   POST   /api/improvements/[id]/restore
 */

const mockSelect = vi.hoisted(() => vi.fn())
const mockInsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: { id: 'customer_id', userId: 'user_id' },
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

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth', () => ({ auth: mockAuth }))
vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
      _body: data,
    }),
  },
}))

const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('@/src/winback/lib/events', () => ({ logEvent: mockLogEvent }))

// Helper — build a Drizzle-style chain. The .where() step is both
// awaitable (for count-style queries that resolve directly off where)
// and chainable into .limit / .orderBy (for list/lookup queries).
function chain(rows: unknown[]) {
  const step: unknown = {
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    orderBy: vi.fn().mockResolvedValue(rows),
    limit:   vi.fn().mockResolvedValue(rows),
  }
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(step),
    }),
  }
}

function customerLookup(customerId: string | null) {
  return chain(customerId ? [{ id: customerId }] : [])
}

beforeEach(() => {
  vi.resetAllMocks()
})

import { GET, POST } from '@/app/api/improvements/route'
import { PATCH } from '@/app/api/improvements/[id]/route'
import { POST as archive } from '@/app/api/improvements/[id]/archive/route'
import { POST as restore } from '@/app/api/improvements/[id]/restore/route'

describe('GET /api/improvements', () => {
  it('rejects unauthenticated', async () => {
    mockAuth.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns the merchant\'s improvements ordered by dateShipped desc', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    const fakeImprovements = [
      { id: 'imp_1', title: 'SSO', dateShipped: new Date('2026-05-10') },
      { id: 'imp_2', title: 'CSV',  dateShipped: new Date('2026-05-05') },
    ]
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))  // resolveCustomerId
      .mockReturnValueOnce(chain(fakeImprovements))   // list query

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json() as { improvements: typeof fakeImprovements }
    expect(body.improvements).toHaveLength(2)
  })

  it('404s when the customer row is missing', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_unconnected' } })
    mockSelect.mockReturnValueOnce(customerLookup(null))
    const res = await GET()
    expect(res.status).toBe(404)
  })
})

describe('POST /api/improvements', () => {
  function makeReq(body: unknown): Request {
    return new Request('http://localhost/api/improvements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects bad payload (title too short)', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect.mockReturnValueOnce(customerLookup('cust_1'))
    const res = await POST(makeReq({ title: 'x', description: 'ok', dateShipped: '2026-05-10' }))
    expect(res.status).toBe(400)
  })

  it('rejects future dateShipped', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect.mockReturnValueOnce(customerLookup('cust_1'))
    const future = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString().slice(0, 10)
    const res = await POST(makeReq({
      title: 'Shipped SSO',
      description: 'SAML + Okta',
      dateShipped: future,
    }))
    expect(res.status).toBe(400)
  })

  it('409s when already at the 10-active cap', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(chain([{ active: 10 }]))  // count query

    const res = await POST(makeReq({
      title: 'Shipped SSO',
      description: 'SAML + Okta',
      dateShipped: '2026-05-10',
    }))
    expect(res.status).toBe(409)
  })

  it('creates a published improvement when input is valid and under the cap', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(chain([{ active: 3 }]))

    const fakeRow = { id: 'new_1', status: 'published' }
    mockInsert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([fakeRow]),
      }),
    })

    const res = await POST(makeReq({
      title: 'Shipped SSO',
      description: 'SAML + Okta',
      dateShipped: '2026-05-10',
      addressesPattern: 'Native SSO',
    }))
    expect(res.status).toBe(201)
    expect(mockInsert).toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'improvement_published' }),
    )
  })
})

describe('PATCH /api/improvements/[id]', () => {
  function makeReq(body: unknown): Request {
    return new Request('http://localhost/api/improvements/x', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  function params(id: string) { return { params: Promise.resolve({ id }) } }

  it('rejects unauthenticated', async () => {
    mockAuth.mockResolvedValue(null)
    const res = await PATCH(makeReq({ title: 'New title here' }), params('imp_1'))
    expect(res.status).toBe(401)
  })

  it('404s when improvement not found / not owned', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect.mockReturnValueOnce(customerLookup('cust_1'))
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),  // no row matched
        }),
      }),
    })
    const res = await PATCH(makeReq({ title: 'New title here' }), params('imp_unknown'))
    expect(res.status).toBe(404)
  })

  it('updates only the fields provided', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect.mockReturnValueOnce(customerLookup('cust_1'))
    const setSpy = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'imp_1' }]),
      }),
    })
    mockUpdate.mockReturnValue({ set: setSpy })

    const res = await PATCH(makeReq({ title: 'Renamed improvement' }), params('imp_1'))
    expect(res.status).toBe(200)
    const args = setSpy.mock.calls[0][0]
    expect(args.title).toBe('Renamed improvement')
    expect(args.description).toBeUndefined()
    expect(args.dateShipped).toBeUndefined()
    expect(args.updatedAt).toBeInstanceOf(Date)
  })
})

describe('POST /api/improvements/[id]/archive', () => {
  function makeReq(body: unknown): Request {
    return new Request('http://localhost/x/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  function params(id: string) { return { params: Promise.resolve({ id }) } }

  it('rejects when confirmed flag is missing', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect.mockReturnValueOnce(customerLookup('cust_1'))
    const res = await archive(makeReq({}), params('imp_1'))
    expect(res.status).toBe(400)
  })

  it('rejects when confirmed is not literal true', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect.mockReturnValueOnce(customerLookup('cust_1'))
    const res = await archive(makeReq({ confirmed: 'yes' }), params('imp_1'))
    expect(res.status).toBe(400)
  })

  it('archives when confirmed is true', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect.mockReturnValueOnce(customerLookup('cust_1'))
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'imp_1', status: 'archived' }]),
        }),
      }),
    })

    const res = await archive(makeReq({ confirmed: true }), params('imp_1'))
    expect(res.status).toBe(200)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'improvement_archived' }),
    )
  })
})

describe('POST /api/improvements/[id]/restore', () => {
  function params(id: string) { return { params: Promise.resolve({ id }) } }
  function req(): Request { return new Request('http://localhost/x/restore', { method: 'POST' }) }

  it('409s if restoring would push past the 10-active cap', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(chain([{ active: 10 }]))
    const res = await restore(req(), params('imp_1'))
    expect(res.status).toBe(409)
  })

  it('restores when under the cap', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user_1' } })
    mockSelect
      .mockReturnValueOnce(customerLookup('cust_1'))
      .mockReturnValueOnce(chain([{ active: 4 }]))
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: 'imp_1', status: 'published' }]),
        }),
      }),
    })
    const res = await restore(req(), params('imp_1'))
    expect(res.status).toBe(200)
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'improvement_restored' }),
    )
  })
})
