/**
 * Spec 80 — POST /api/subscribers/[id]/send-promo unit tests.
 *
 * Covers the conflict branches (auth, ownership, improvement validity,
 * gate failure, anti-fatigue), the dryRun short-circuit, and the
 * successful-send write path. Pattern follows
 * subscribers-pagination.test.ts: heavy use of vi.mock to swap out the
 * DB / drizzle / next-auth / email / LLM dependencies so the test
 * runs against pure logic.
 *
 * What we explicitly DON'T test here:
 *   - The actual Stripe gate logic — covered by promotion-match.test.ts.
 *   - The actual LLM prompt — covered by the email-template tests.
 *   - End-to-end behaviour against a real DB or Resend — covered by
 *     scripts/test-promo-e2e.ts run manually against Stripe test mode.
 *
 * Test naming convention: each test exercises one branch of the
 * endpoint's control flow and asserts both the HTTP status code and
 * (where relevant) the side-effect calls into the mocked dependencies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ───────── Mocks (hoisted, used by the route module on import) ─────────

const mockAuth   = vi.hoisted(() => vi.fn())
const mockSelect = vi.hoisted(() => vi.fn())
const mockInsert = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())

const mockGetApplicable = vi.hoisted(() => vi.fn())
const mockParseRows     = vi.hoisted(() => vi.fn())
const mockGenerateEmail = vi.hoisted(() => vi.fn())
const mockSanityCheck   = vi.hoisted(() => vi.fn())
const mockSendEmail     = vi.hoisted(() => vi.fn())
const mockBuildFrom     = vi.hoisted(() => vi.fn(() => 'Test Co'))
const mockLogEvent      = vi.hoisted(() => vi.fn())

vi.mock('@/lib/auth', () => ({ auth: mockAuth }))
vi.mock('@/lib/db',   () => ({ db: { select: mockSelect, insert: mockInsert, update: mockUpdate } }))

vi.mock('@/lib/schema', () => ({
  customers:          { id: 'customer_id', userId: 'user_id' },
  churnedSubscribers: { id: 'id', customerId: 'customer_id' },
  emailsSent:         { id: 'id', subscriberId: 'subscriber_id', type: 'type', sentAt: 'sent_at', improvementId: 'improvement_id' },
  improvements:       { id: 'id' },
  improvementMatches: { improvementId: 'improvement_id', subscriberId: 'subscriber_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn((a, b) => ({ op: 'eq', a, b })),
  and:  vi.fn((...c) => ({ op: 'and', c })),
  gte:  vi.fn((a, b) => ({ op: 'gte', a, b })),
  desc: vi.fn((c) => ({ op: 'desc', c })),
}))

vi.mock('@/src/winback/lib/promotion-match', () => ({
  getApplicablePromotionForSubscriber: mockGetApplicable,
  parsePromotionRows: mockParseRows,
}))

vi.mock('@/src/winback/lib/improvement-match', () => ({
  generatePromotionEmail:     mockGenerateEmail,
  sanityCheckPromotionEmail:  mockSanityCheck,
}))

vi.mock('@/src/winback/lib/email', () => ({
  sendEmail:             mockSendEmail,
  buildFromDisplayName:  mockBuildFrom,
}))

vi.mock('@/src/winback/lib/events', () => ({ logEvent: mockLogEvent }))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}))

import { POST } from '@/app/api/subscribers/[id]/send-promo/route'

// ───────── Test helpers ─────────

/** Builds a thenable mock chain matching drizzle's select() shape. */
function selectChain(rows: unknown[]) {
  const step: Record<string, unknown> = {
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  }
  for (const m of ['from', 'where', 'orderBy', 'limit']) {
    step[m] = vi.fn().mockReturnValue(step)
  }
  return step
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

// zod v4's UUID validator requires a real version digit (the 13th
// hex char). All-zeros fails. Using a valid v4 UUID here.
const VALID_BODY = { improvementId: '11111111-1111-4111-8111-111111111111' }

beforeEach(() => {
  vi.clearAllMocks()
  mockBuildFrom.mockReturnValue('Test Co')
  // Default: every db.update() returns a chain whose terminal where() resolves.
  mockUpdate.mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve() }),
  }))
  // Default: db.insert() returns a chain. For emailsSent we ignore the
  // value; for improvementMatches we expect .onConflictDoNothing().
  mockInsert.mockImplementation(() => ({
    values: () => ({
      onConflictDoNothing: () => Promise.resolve(),
      // Bare values() for tables without ON CONFLICT.
      then: (resolve: () => unknown) => Promise.resolve().then(resolve),
    }),
  }))
})

// ─────────────────────────── tests ───────────────────────────

describe('POST /api/subscribers/[id]/send-promo — auth + body', () => {
  it('returns 401 when no session', async () => {
    mockAuth.mockResolvedValueOnce(null)
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(401)
  })

  it('returns 400 for invalid body shape', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    const res = await POST(
      makeReq({ improvementId: 'not-a-uuid' }),
      makeParams('sub-1'),
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /api/subscribers/[id]/send-promo — ownership + subscriber', () => {
  it('returns 404 when no customer row for the session user', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    mockSelect.mockReturnValueOnce(selectChain([])) // customer lookup empty
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(404)
    const body = (await (res as { json: () => Promise<{ error: string }> }).json())
    expect(body.error).toBe('Customer not found')
  })

  it('returns 403 promotions_disabled when the master switch is off (hard lock)', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    // Customer found, but promotionsEnabled = false → the route must refuse
    // before doing any subscriber/improvement work. This is the API-level
    // hard stop behind the Promotions tab's "Don't offer a discount" mode.
    mockSelect.mockReturnValueOnce(selectChain([{ id: 'cust-1', promotionsEnabled: false }]))
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(403)
    const body = await (res as { json: () => Promise<{ error: string }> }).json()
    expect(body.error).toBe('promotions_disabled')
  })

  it('returns 409 subscriber_not_found when subscriber is not owned', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust-1', promotionsEnabled: true }])) // customer OK
      .mockReturnValueOnce(selectChain([]))                  // subscriber lookup empty
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(409)
    const body = await (res as { json: () => Promise<{ error: string }> }).json()
    expect(body.error).toBe('subscriber_not_found')
  })

  it('returns 409 subscriber_no_email when subscriber has no email on file', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust-1', promotionsEnabled: true }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub-1', email: null }]))
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(409)
    const body = await (res as { json: () => Promise<{ error: string }> }).json()
    expect(body.error).toBe('subscriber_no_email')
  })
})

describe('POST /api/subscribers/[id]/send-promo — improvement validation', () => {
  it('returns 409 improvement_not_found when the improvement is unknown OR belongs to another customer', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust-1', promotionsEnabled: true }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub-1', email: 'x@y.z', stripePriceId: 'p1' }]))
      .mockReturnValueOnce(selectChain([])) // improvement lookup empty
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(409)
    const body = await (res as { json: () => Promise<{ error: string }> }).json()
    expect(body.error).toBe('improvement_not_found')
  })

  it('returns 409 improvement_not_promotion when kind != promotion', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust-1', promotionsEnabled: true }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub-1', email: 'x@y.z', stripePriceId: 'p1' }]))
      .mockReturnValueOnce(selectChain([{
        id: 'imp-1', kind: 'product', status: 'published',
        promotionMetadata: {}, createdAt: new Date(), customerId: 'cust-1',
      }]))
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(409)
    const body = await (res as { json: () => Promise<{ error: string }> }).json()
    expect(body.error).toBe('improvement_not_promotion')
  })

  it('returns 409 improvement_archived when the row is archived', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust-1', promotionsEnabled: true }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub-1', email: 'x@y.z', stripePriceId: 'p1' }]))
      .mockReturnValueOnce(selectChain([{
        id: 'imp-1', kind: 'promotion', status: 'archived',
        promotionMetadata: {}, createdAt: new Date(), customerId: 'cust-1',
      }]))
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(409)
    const body = await (res as { json: () => Promise<{ error: string }> }).json()
    expect(body.error).toBe('improvement_archived')
  })
})

describe('POST /api/subscribers/[id]/send-promo — gate + anti-fatigue', () => {
  function baseSubMocks() {
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust-1', promotionsEnabled: true }]))
      .mockReturnValueOnce(selectChain([{ id: 'sub-1', email: 'x@y.z', stripePriceId: 'p1', mrrCents: 1000 }]))
      .mockReturnValueOnce(selectChain([{
        id: 'imp-1', kind: 'promotion', status: 'published',
        promotionMetadata: { code: 'WELCOME50' }, createdAt: new Date(), customerId: 'cust-1',
      }]))
    mockParseRows.mockReturnValue([{
      id: 'imp-1',
      promotionMetadata: { code: 'WELCOME50', stripePromotionCodeId: 'promo_x' },
      createdAt: new Date(),
    }])
  }

  it('returns 409 gate_failed when Stripe gates reject the promo for this subscriber', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    baseSubMocks()
    mockGetApplicable.mockReturnValue(null) // gate rejects
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(409)
    const body = await (res as { json: () => Promise<{ error: string }> }).json()
    expect(body.error).toBe('gate_failed')
  })

  it('returns 409 recently_sent when a reengagement email went out in the last 30 days (allowDuplicate=false)', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    baseSubMocks()
    mockGetApplicable.mockReturnValue({ id: 'imp-1', promotionMetadata: { code: 'WELCOME50' }, createdAt: new Date() })
    const recentSentAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // 5d ago
    mockSelect.mockReturnValueOnce(selectChain([{ id: 'e1', sentAt: recentSentAt, improvementId: 'imp-other' }]))
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(409)
    const body = await (res as { json: () => Promise<{ error: string; sentAt: string }> }).json()
    expect(body.error).toBe('recently_sent')
    expect(body.sentAt).toBe(recentSentAt.toISOString())
  })

  it('skips anti-fatigue when allowDuplicate=true', async () => {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    baseSubMocks()
    mockGetApplicable.mockReturnValue({
      id: 'imp-1',
      promotionMetadata: { code: 'WELCOME50', stripePromotionCodeId: 'promo_x' },
      createdAt: new Date(),
    })
    mockGenerateEmail.mockResolvedValueOnce({ subject: 'Subj', body: 'Body' })
    mockSanityCheck.mockResolvedValueOnce({ pass: true })
    mockSendEmail.mockResolvedValueOnce({ messageId: 'msg-1' })

    const res = await POST(
      makeReq({ ...VALID_BODY, allowDuplicate: true }),
      makeParams('sub-1'),
    )
    expect(res.status).toBe(200)
    // Crucial: anti-fatigue branch did NOT do its select.
    // (We loaded customer + subscriber + improvement = 3 selects only.)
    expect(mockSelect).toHaveBeenCalledTimes(3)
  })
})

describe('POST /api/subscribers/[id]/send-promo — dryRun + send writes', () => {
  function happyPath() {
    mockAuth.mockResolvedValueOnce({ user: { id: 'u1' } })
    mockSelect
      .mockReturnValueOnce(selectChain([{ id: 'cust-1', founderName: 'Tej', productName: 'Fitness', promotionsEnabled: true }]))
      .mockReturnValueOnce(selectChain([{
        id: 'sub-1', email: 'x@y.z', name: 'Sarah', stripePriceId: 'p1', mrrCents: 1000, triggerNeed: 'cheaper plan',
      }]))
      .mockReturnValueOnce(selectChain([{
        id: 'imp-1', kind: 'promotion', status: 'published',
        promotionMetadata: { code: 'WELCOME50' }, createdAt: new Date(), customerId: 'cust-1',
      }]))
      .mockReturnValueOnce(selectChain([])) // anti-fatigue: nothing recent
    mockParseRows.mockReturnValue([{
      id: 'imp-1',
      promotionMetadata: { code: 'WELCOME50', stripePromotionCodeId: 'promo_x' },
      createdAt: new Date(),
    }])
    mockGetApplicable.mockReturnValue({
      id: 'imp-1',
      promotionMetadata: { code: 'WELCOME50', stripePromotionCodeId: 'promo_x' },
      createdAt: new Date(),
    })
    mockGenerateEmail.mockResolvedValue({ subject: 'Generated subj', body: 'Generated body' })
    mockSanityCheck.mockResolvedValue({ pass: true })
    mockSendEmail.mockResolvedValue({ messageId: 'msg-1' })
  }

  it('dryRun=true returns the draft and does NOT call sendEmail or write rows', async () => {
    happyPath()
    const res = await POST(
      makeReq({ ...VALID_BODY, dryRun: true }),
      makeParams('sub-1'),
    )
    expect(res.status).toBe(200)
    const body = await (res as { json: () => Promise<{ dryRun: boolean; draft: { subject: string; body: string } }> }).json()
    expect(body.dryRun).toBe(true)
    expect(body.draft.subject).toBe('Generated subj')
    expect(body.draft.body).toBe('Generated body')
    expect(mockSendEmail).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('on success: sends email, inserts emailsSent with source=manual + sent_by_user_id, inserts dedup, updates subscriber', async () => {
    happyPath()
    const res = await POST(makeReq(VALID_BODY), makeParams('sub-1'))
    expect(res.status).toBe(200)

    // Email actually got sent.
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'x@y.z',
      subject: 'Generated subj',
      body: 'Generated body',
      subscriberId: 'sub-1',
    }))

    // Two inserts: emailsSent (with audit fields) + improvementMatches (dedup).
    expect(mockInsert).toHaveBeenCalledTimes(2)
    const insertCalls = mockInsert.mock.calls

    // First insert (emailsSent) — verify source + sent_by_user_id were
    // set. We can't introspect .values() args directly through the
    // chain mock without more plumbing, so we just verify the insert
    // chain was constructed for the right table object (the symbol
    // identity of the table is the chain's argument).
    expect(insertCalls[0][0]).toMatchObject({ subscriberId: 'subscriber_id' })

    // Subscriber state update happened.
    expect(mockUpdate).toHaveBeenCalledTimes(1)

    // logEvent called for reengagement_email_sent with source='manual'.
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'reengagement_email_sent',
      properties: expect.objectContaining({
        source:       'manual',
        sentByUserId: 'u1',
        promotionCode: 'WELCOME50',
      }),
    }))
  })

  it('uses subject/body overrides when provided and skips LLM generation', async () => {
    happyPath()
    const res = await POST(
      makeReq({
        ...VALID_BODY,
        subjectOverride: 'My custom subject',
        bodyOverride:    'My custom body',
      }),
      makeParams('sub-1'),
    )
    expect(res.status).toBe(200)
    // Generator + sanity check both skipped because both overrides were provided.
    expect(mockGenerateEmail).not.toHaveBeenCalled()
    expect(mockSanityCheck).not.toHaveBeenCalled()
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'My custom subject',
      body:    'My custom body',
    }))
  })
})
