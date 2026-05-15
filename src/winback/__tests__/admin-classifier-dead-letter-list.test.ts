/**
 * Spec 76 — GET /api/admin/classifier-dead-letter-list tests.
 *
 * The route is mostly a single raw SQL query with a LATERAL join, so
 * the test focuses on the bits we can verify without a real DB:
 *   - admin gate (401 unauthenticated, 403 non-admin)
 *   - happy path returns the rows from execute() as { rows, total }
 *   - DB error → 500
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAdmin = vi.hoisted(() => vi.fn())
const mockExecute      = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ requireAdmin: mockRequireAdmin }))

vi.mock('@/lib/db', () => ({
  getDbReadOnly: () => ({ execute: mockExecute }),
}))

vi.mock('drizzle-orm', () => ({
  // The route uses sql`...` as a template tag. We only care that it's
  // callable — Drizzle resolves the actual SQL on the real DB; our mock
  // intercepts execute() so the tag value doesn't matter.
  sql: Object.assign((..._args: unknown[]) => ({ op: 'sql' }), {
    raw: (s: string) => s,
  }),
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}))

import { GET } from '@/app/api/admin/classifier-dead-letter-list/route'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('GET /api/admin/classifier-dead-letter-list', () => {
  it('returns 401 when unauthenticated', async () => {
    mockRequireAdmin.mockResolvedValue({ error: 'Unauthorized', status: 401 })
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns 403 when authenticated but not admin', async () => {
    mockRequireAdmin.mockResolvedValue({ error: 'Forbidden', status: 403 })
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it('returns rows + total in happy path', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    const fakeRows = [
      {
        id:                    'sub_a',
        customer_id:           'cust_1',
        email:                 'alice@example.com',
        name:                  'Alice',
        plan_name:             'Pro',
        mrr_cents:             2900,
        classify_attempts:     3,
        updated_at:            '2026-05-15T10:00:00Z',
        customer_product_name: 'Acme',
        customer_email:        'founder@acme.com',
        last_error:            'LLM output failed Zod validation',
      },
      {
        id:                    'sub_b',
        customer_id:           'cust_1',
        email:                 'bob@example.com',
        name:                  null,
        plan_name:             null,
        mrr_cents:             0,
        classify_attempts:     4,
        updated_at:            '2026-05-15T09:00:00Z',
        customer_product_name: 'Acme',
        customer_email:        'founder@acme.com',
        last_error:            null,
      },
    ]
    mockExecute.mockResolvedValue({ rows: fakeRows })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json() as { rows: typeof fakeRows; total: number }
    expect(body.rows).toEqual(fakeRows)
    expect(body.total).toBe(2)
  })

  it('returns 0 rows and total=0 when the queue is empty', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    mockExecute.mockResolvedValue({ rows: [] })

    const res = await GET()
    const body = await res.json() as { rows: unknown[]; total: number }
    expect(body.rows).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  it('returns 500 on DB error', async () => {
    mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
    mockExecute.mockRejectedValue(new Error('connection refused'))

    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json() as { error: string }
    expect(body.error).toContain('connection refused')
  })
})
