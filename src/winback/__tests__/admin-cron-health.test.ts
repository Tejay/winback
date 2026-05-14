/**
 * Spec 69 — getCronHealth() merges DB rows with the static schedule
 * config and applies the stale-heuristic correctly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())

vi.mock('../../../lib/db', () => ({
  getDbReadOnly: () => ({ select: mockSelect }),
}))

vi.mock('../../../lib/schema', () => ({
  wbEvents: { name: 'name', properties: 'properties', createdAt: 'created_at' },
}))

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn((a, b) => ({ eq: [a, b] })),
  desc: vi.fn((a) => ({ desc: a })),
  sql:  Object.assign(
    (strings: TemplateStringsArray, ...args: unknown[]) => ({ sql: strings.join('?'), args }),
    { raw: (s: string) => ({ raw: s }) },
  ),
}))

import { getCronHealth } from '../../../lib/admin/cron-queries'

function chain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getCronHealth', () => {
  it('marks every cron as never-run when no cron_run events exist', async () => {
    mockSelect.mockReturnValue(chain([]))
    const rows = await getCronHealth()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.status).toBe('never-run')
      expect(r.lastRunAt).toBeNull()
      expect(r.durationMs).toBeNull()
    }
  })

  it('marks status=ok when latest run is recent + ok=true', async () => {
    mockSelect.mockReturnValue(chain([
      {
        name: 'reengagement',
        ok: true,
        durationMs: 1500,
        errorMessage: null,
        createdAt: new Date(Date.now() - 60_000),  // 1 min ago
      },
    ]))
    const rows = await getCronHealth()
    const reeng = rows.find((r) => r.name === 'reengagement')!
    expect(reeng.status).toBe('ok')
    expect(reeng.durationMs).toBe(1500)
  })

  it('marks status=failed when latest run is ok=false', async () => {
    mockSelect.mockReturnValue(chain([
      {
        name: 'billing-nudge',
        ok: false,
        durationMs: 300,
        errorMessage: 'Resend API down',
        createdAt: new Date(Date.now() - 30_000),
      },
    ]))
    const rows = await getCronHealth()
    const bn = rows.find((r) => r.name === 'billing-nudge')!
    expect(bn.status).toBe('failed')
    expect(bn.errorMessage).toBe('Resend API down')
  })

  it('marks status=stale when latest ok=true run is older than maxInterval', async () => {
    // drain-paused-queue has a 15-minute stale window. Synthesize a 2-hour-old run.
    mockSelect.mockReturnValue(chain([
      {
        name: 'drain-paused-queue',
        ok: true,
        durationMs: 200,
        errorMessage: null,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    ]))
    const rows = await getCronHealth()
    const drain = rows.find((r) => r.name === 'drain-paused-queue')!
    expect(drain.status).toBe('stale')
  })

  it('uses only the latest run per cron when multiple rows exist', async () => {
    mockSelect.mockReturnValue(chain([
      { name: 'reengagement', ok: false, durationMs: 100, errorMessage: 'old fail', createdAt: new Date(Date.now() - 30_000) },
      { name: 'reengagement', ok: true,  durationMs: 200, errorMessage: null,       createdAt: new Date(Date.now() - 60 * 60 * 1000) },
    ]))
    const rows = await getCronHealth()
    const reeng = rows.find((r) => r.name === 'reengagement')!
    // First row in the input list is most recent (orderBy DESC), so status=failed.
    expect(reeng.status).toBe('failed')
    expect(reeng.errorMessage).toBe('old fail')
  })
})
