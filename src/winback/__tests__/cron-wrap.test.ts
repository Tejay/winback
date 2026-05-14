/**
 * Spec 69 — withCron wrapper tests.
 *
 * Verifies auth gating + cron_run event emission on both success and
 * failure paths. The body fn is mocked; no DB or schema involved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { withCron } from '../lib/cron-wrap'

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/cron/test', { headers })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'secret-1'
})

describe('withCron', () => {
  it('rejects 401 when Authorization header missing', async () => {
    const fn = vi.fn().mockResolvedValue({ stats: { n: 1 } })
    const res = await withCron('demo', makeReq(), fn)
    expect(res.status).toBe(401)
    expect(fn).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('rejects 401 when Authorization header has wrong secret', async () => {
    const fn = vi.fn().mockResolvedValue({})
    const res = await withCron('demo', makeReq({ authorization: 'Bearer wrong' }), fn)
    expect(res.status).toBe(401)
    expect(fn).not.toHaveBeenCalled()
  })

  it('happy path: runs fn, returns merged JSON, logs cron_run ok=true', async () => {
    const fn = vi.fn().mockResolvedValue({ processed: 7 })
    const res = await withCron('demo', makeReq({ authorization: 'Bearer secret-1' }), fn)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, processed: 7 })

    expect(mockLogEvent).toHaveBeenCalledOnce()
    const ev = mockLogEvent.mock.calls[0][0]
    expect(ev.name).toBe('cron_run')
    expect(ev.properties).toEqual(expect.objectContaining({ name: 'demo', ok: true }))
    expect(ev.properties.durationMs).toEqual(expect.any(Number))
  })

  it('on error: logs cron_run ok=false with errorMessage AND re-raises', async () => {
    const err = new Error('boom')
    const fn = vi.fn().mockRejectedValue(err)
    await expect(
      withCron('demo', makeReq({ authorization: 'Bearer secret-1' }), fn),
    ).rejects.toThrow('boom')

    expect(mockLogEvent).toHaveBeenCalledOnce()
    const ev = mockLogEvent.mock.calls[0][0]
    expect(ev.properties).toEqual(expect.objectContaining({
      name: 'demo',
      ok: false,
      errorMessage: 'boom',
    }))
  })

  it('still re-raises even if cron_run logEvent itself fails', async () => {
    mockLogEvent.mockRejectedValueOnce(new Error('events table down'))
    const fn = vi.fn().mockRejectedValue(new Error('inner failure'))
    await expect(
      withCron('demo', makeReq({ authorization: 'Bearer secret-1' }), fn),
    ).rejects.toThrow('inner failure')
  })
})
