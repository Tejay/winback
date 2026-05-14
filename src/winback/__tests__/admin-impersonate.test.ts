/**
 * Spec 68 — POST /api/admin/actions/impersonate + stop-impersonating tests.
 *
 * Mocks: requireAdmin, auth (current session), db.select chain, encode,
 * cookies, logEvent.
 *
 * Verifies the gates and that the cookie + audit-log writes happen
 * with the right payload shape. Cookie encryption itself is exercised
 * by NextAuth and not re-tested.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAdmin = vi.hoisted(() => vi.fn())
const mockAuth         = vi.hoisted(() => vi.fn())
const mockSelect       = vi.hoisted(() => vi.fn())
const mockEncode       = vi.hoisted(() => vi.fn().mockResolvedValue('encoded-jwt'))
const mockCookiesSet   = vi.hoisted(() => vi.fn())
const mockCookiesDel   = vi.hoisted(() => vi.fn())
const mockCookies      = vi.hoisted(() => vi.fn().mockResolvedValue({
  set: mockCookiesSet,
  delete: mockCookiesDel,
}))
const mockLogEvent     = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/lib/auth', () => ({
  auth: mockAuth,
  requireAdmin: mockRequireAdmin,
  getSessionCookieName: () => 'authjs.session-token',
}))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  users:     { id: 'user_id', email: 'user_email', isAdmin: 'is_admin' },
  customers: { id: 'cust_id', userId: 'user_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

vi.mock('next-auth/jwt', () => ({
  encode: mockEncode,
}))

vi.mock('next/headers', () => ({
  cookies: mockCookies,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST as startPOST } from '../../../app/api/admin/actions/impersonate/route'
import { POST as stopPOST  } from '../../../app/api/admin/actions/stop-impersonating/route'

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/actions/impersonate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXTAUTH_SECRET = 'test-secret'
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_1' })
  mockAuth.mockResolvedValue({
    user: { id: 'admin_1', email: 'admin@example.com' },
  })
})

describe('POST /api/admin/actions/impersonate', () => {
  it('rejects when requireAdmin denies', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Not signed in', status: 401 })
    const res = await startPOST(makeReq({ targetUserId: 'u', confirmEmail: 'x' }))
    expect(res.status).toBe(401)
    expect(mockEncode).not.toHaveBeenCalled()
  })

  it('rejects 409 when already impersonating', async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: 'merchant_1', email: 'merchant@example.com' },
      impersonator: { adminId: 'admin_1', adminEmail: 'admin@example.com', startedAt: '', expiresAt: '' },
    })
    const res = await startPOST(makeReq({ targetUserId: 'u', confirmEmail: 'x' }))
    expect(res.status).toBe(409)
    expect(mockEncode).not.toHaveBeenCalled()
  })

  it('rejects 400 when targetUserId or confirmEmail missing', async () => {
    const res = await startPOST(makeReq({}))
    expect(res.status).toBe(400)
  })

  it('rejects 404 when target user not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const res = await startPOST(makeReq({ targetUserId: 'u', confirmEmail: 'x@y.com' }))
    expect(res.status).toBe(404)
  })

  it('rejects 400 when confirmEmail does not match target', async () => {
    mockSelect.mockReturnValueOnce(selectChain([{ id: 'merchant_1', email: 'real@example.com', isAdmin: false }]))
    const res = await startPOST(makeReq({ targetUserId: 'merchant_1', confirmEmail: 'wrong@example.com' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/confirmEmail/i)
  })

  it('rejects 403 when target is an admin', async () => {
    mockSelect.mockReturnValueOnce(selectChain([{ id: 'admin_2', email: 'other-admin@example.com', isAdmin: true }]))
    const res = await startPOST(makeReq({ targetUserId: 'admin_2', confirmEmail: 'other-admin@example.com' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/admin/i)
  })

  it('happy path: mints JWT, sets cookie, logs impersonation_start', async () => {
    // 1st select = target user; 2nd select = admin email
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'merchant_1', email: 'merchant@example.com', isAdmin: false }]))
      .mockReturnValueOnce(selectChain([{ email: 'admin@example.com' }]))

    const res = await startPOST(makeReq({ targetUserId: 'merchant_1', confirmEmail: 'merchant@example.com' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.redirect).toBe('/dashboard')
    expect(body.expiresAt).toBeTruthy()

    expect(mockEncode).toHaveBeenCalledOnce()
    const encodeArgs = mockEncode.mock.calls[0][0]
    expect(encodeArgs.token.id).toBe('merchant_1')
    expect(encodeArgs.token.email).toBe('merchant@example.com')
    expect(encodeArgs.token.impersonator).toEqual(expect.objectContaining({
      adminId: 'admin_1',
      adminEmail: 'admin@example.com',
    }))
    expect(encodeArgs.maxAge).toBe(30 * 60)

    expect(mockCookiesSet).toHaveBeenCalledWith(
      'authjs.session-token',
      'encoded-jwt',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    )

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      properties: expect.objectContaining({
        action: 'impersonation_start',
        targetUserId: 'merchant_1',
        targetEmail: 'merchant@example.com',
      }),
    }))
  })

  it('happy path: confirmEmail match is case-insensitive', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'merchant_1', email: 'MERCHANT@Example.COM', isAdmin: false }]))
      .mockReturnValueOnce(selectChain([{ email: 'admin@example.com' }]))
    const res = await startPOST(makeReq({ targetUserId: 'merchant_1', confirmEmail: 'merchant@example.com' }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/admin/actions/stop-impersonating', () => {
  function stopReq(): Request {
    return new Request('http://localhost/api/admin/actions/stop-impersonating', { method: 'POST' })
  }

  it('rejects 400 when no active impersonation', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'admin_1', email: 'admin@example.com' } })
    const res = await stopPOST(stopReq())
    expect(res.status).toBe(400)
    expect(mockEncode).not.toHaveBeenCalled()
  })

  it('happy path: restores admin JWT, redirects to /admin/customers/<customerId>, logs stop', async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: 'merchant_1', email: 'merchant@example.com' },
      impersonator: {
        adminId: 'admin_1',
        adminEmail: 'admin@example.com',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        expiresAt: new Date(Date.now() + 1000 * 60).toISOString(),
      },
    })
    // 1st select = customer row, 2nd select = admin row
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust_99' }]))
      .mockReturnValueOnce(selectChain([{ id: 'admin_1', email: 'admin@example.com', isAdmin: true }]))

    const res = await stopPOST(stopReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.redirect).toBe('/admin/customers/cust_99')

    expect(mockEncode).toHaveBeenCalledOnce()
    const encodeArgs = mockEncode.mock.calls[0][0]
    expect(encodeArgs.token.id).toBe('admin_1')
    expect(encodeArgs.token.impersonator).toBeUndefined()

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_1',
      properties: expect.objectContaining({
        action: 'impersonation_stop',
        targetUserId: 'merchant_1',
        elapsedSecs: expect.any(Number),
      }),
    }))
  })

  it('falls back to /admin when no customer row found', async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: 'merchant_1', email: 'merchant@example.com' },
      impersonator: {
        adminId: 'admin_1', adminEmail: 'admin@example.com',
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    mockSelect
      .mockReturnValueOnce(selectChain([]))  // no customer
      .mockReturnValueOnce(selectChain([{ id: 'admin_1', email: 'admin@example.com', isAdmin: true }]))
    const res = await stopPOST(stopReq())
    const body = await res.json()
    expect(body.redirect).toBe('/admin')
  })

  it('wipes cookie + redirects to /login if admin lost privileges mid-session', async () => {
    mockAuth.mockResolvedValueOnce({
      user: { id: 'merchant_1', email: 'merchant@example.com' },
      impersonator: {
        adminId: 'admin_1', adminEmail: 'admin@example.com',
        startedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust_99' }]))
      .mockReturnValueOnce(selectChain([{ id: 'admin_1', email: 'admin@example.com', isAdmin: false }]))
    const res = await stopPOST(stopReq())
    const body = await res.json()
    expect(body.redirect).toBe('/login')
    expect(mockCookiesDel).toHaveBeenCalledWith('authjs.session-token')
    expect(mockEncode).not.toHaveBeenCalled()
  })
})
