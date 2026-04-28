/**
 * Spec 31 — POST /api/admin/actions/issue-pilot tests.
 *
 * Verifies:
 *  - requireAdmin gate (401/403 paths)
 *  - 10-cap enforcement (rejects when slotsUsed >= PILOT_CAP)
 *  - happy path: issues a token, returns a URL containing it, emits
 *    admin_action event with action: 'issue_pilot'
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAdmin   = vi.hoisted(() => vi.fn())
const mockCountSlots     = vi.hoisted(() => vi.fn())
const mockIssueToken     = vi.hoisted(() => vi.fn())
const mockLogEvent       = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/auth', () => ({
  requireAdmin: mockRequireAdmin,
}))

vi.mock('@/src/winback/lib/pilot', () => ({
  countPilotSlotsUsed: mockCountSlots,
  issuePilotToken:     mockIssueToken,
  PILOT_CAP:           10,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/admin/actions/issue-pilot/route'

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
  mockCountSlots.mockResolvedValue(0)
  mockIssueToken.mockResolvedValue({
    rawToken: 'rawTOKEN123',
    tokenId:  't1',
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60_000),
  })
})

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/actions/issue-pilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/actions/issue-pilot', () => {
  it('rejects when requireAdmin denies', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Not signed in', status: 401 })
    const res = await POST(makeReq({}))
    expect(res.status).toBe(401)
    expect(mockIssueToken).not.toHaveBeenCalled()
  })

  it('returns 409 when the cap is reached', async () => {
    mockCountSlots.mockResolvedValueOnce(10)
    const res = await POST(makeReq({ note: 'Acme' }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/cap reached/i)
    expect(mockIssueToken).not.toHaveBeenCalled()
  })

  it('issues a token + returns a URL containing it + logs admin_action', async () => {
    const res = await POST(makeReq({ note: 'Pilot for Acme' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.url).toBe('https://app.example.com/register?pilotToken=rawTOKEN123')
    expect(body.tokenId).toBe('t1')

    expect(mockIssueToken).toHaveBeenCalledWith(expect.objectContaining({
      note: 'Pilot for Acme',
      createdByUserId: 'admin_1',
    }))
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      properties: expect.objectContaining({
        action: 'issue_pilot',
        tokenId: 't1',
        note:    'Pilot for Acme',
      }),
    }))
  })

  it('treats empty/whitespace note as null', async () => {
    await POST(makeReq({ note: '   ' }))
    expect(mockIssueToken).toHaveBeenCalledWith(expect.objectContaining({
      note: null,
    }))
  })

  it('caps note at 200 characters', async () => {
    await POST(makeReq({ note: 'x'.repeat(500) }))
    const passedNote = mockIssueToken.mock.calls[0][0].note as string
    expect(passedNote.length).toBe(200)
  })
})
