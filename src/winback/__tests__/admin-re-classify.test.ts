/**
 * Spec 27 — POST /api/admin/subscribers/[id]/re-classify
 *
 * Verifies:
 *  - rejects without exact-string confirmCost
 *  - rejects when subscriber not found (404)
 *  - calls classifySubscriber with reconstructed signals
 *  - does NOT write to the DB
 *  - logs admin_action with action='classifier_re_run'
 *  - returns stored + fresh values for diffing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockInsert = vi.hoisted(() => vi.fn())
const mockClassify = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockRequireAdmin = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    insert: mockInsert,
  },
}))

vi.mock('@/lib/auth', () => ({
  requireAdmin: mockRequireAdmin,
}))

vi.mock('@/lib/schema', () => ({
  churnedSubscribers: {
    id: 'id',
    customerId: 'customer_id',
    stripeCustomerId: 'stripe_customer_id',
    stripeSubscriptionId: 'stripe_subscription_id',
    stripePriceId: 'stripe_price_id',
    email: 'email',
    name: 'name',
    planName: 'plan_name',
    mrrCents: 'mrr_cents',
    tenureDays: 'tenure_days',
    everUpgraded: 'ever_upgraded',
    nearRenewal: 'near_renewal',
    paymentFailures: 'payment_failures',
    previousSubs: 'previous_subs',
    stripeEnum: 'stripe_enum',
    stripeComment: 'stripe_comment',
    replyText: 'reply_text',
    billingPortalClickedAt: 'billing_portal_clicked_at',
    cancelledAt: 'cancelled_at',
    tier: 'tier',
    confidence: 'confidence',
    cancellationReason: 'cancellation_reason',
    cancellationCategory: 'cancellation_category',
    triggerNeed: 'trigger_need',
    handoffReasoning: 'handoff_reasoning',
    recoveryLikelihood: 'recovery_likelihood',
  },
  customers: {
    id: 'cust_id',
    founderName: 'founder_name',
    productName: 'product_name',
    changelogText: 'changelog_text',
  },
  emailsSent: { subscriberId: 'subscriber_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq:    vi.fn((a, b) => ({ eq: [a, b] })),
  count: vi.fn(() => ({ count: true })),
}))

vi.mock('@/src/winback/lib/classifier', () => ({
  classifySubscriber: mockClassify,
}))

vi.mock('@/src/winback/lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { POST } from '../../../app/api/admin/subscribers/[id]/re-classify/route'

const COST_CONFIRMATION = 'I understand this costs ~$0.003'

const SUBSCRIBER_ROW = {
  stripeCustomerId: 'cus_test',
  stripeSubscriptionId: 'sub_test',
  stripePriceId: 'price_test',
  email: 'sarah@example.com',
  name: 'Sarah',
  planName: 'Pro',
  mrrCents: 2900,
  tenureDays: 120,
  everUpgraded: false,
  nearRenewal: false,
  paymentFailures: 0,
  previousSubs: 0,
  stripeEnum: 'too_expensive',
  stripeComment: 'CSV cap was limiting',
  replyText: null,
  billingPortalClickedAt: null,
  cancelledAt: new Date('2026-04-20'),
  storedTier: 1,
  storedConfidence: '0.92',
  storedCancellationReason: 'CSV cap',
  storedCancellationCategory: 'Feature',
  storedTriggerNeed: 'Wants uncapped CSV export',
  storedHandoffReasoning: '(stored)',
  storedRecoveryLikelihood: 'high',
  customerId: 'cust_1',
  founderName: 'Alex',
  productName: 'Acme',
  changelogText: 'CSV export rebuilt',
}

const FRESH_CLASSIFICATION = {
  tier: 1,
  tierReason: '...',
  cancellationReason: 'CSV cap (rephrased)',
  cancellationCategory: 'Feature',
  confidence: 0.94,
  suppress: false,
  firstMessage: { subject: 's', body: 'b', sendDelaySecs: 60 },
  triggerKeyword: 'csv',
  triggerNeed: 'Wants uncapped CSV export',
  winBackSubject: '',
  winBackBody: '',
  handoff: false,
  handoffReasoning: '(fresh)',
  recoveryLikelihood: 'medium' as const,
}

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
      where: vi.fn().mockResolvedValue(rows),
    }),
  }
}

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/admin/subscribers/sub_1/re-classify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAdmin.mockResolvedValue({ userId: 'admin_user' })
})

describe('POST /api/admin/subscribers/[id]/re-classify', () => {
  it('rejects with 400 when confirmCost is missing', async () => {
    const res = await POST(makeReq({}), { params: Promise.resolve({ id: 'sub_1' }) })
    expect(res.status).toBe(400)
    expect(mockClassify).not.toHaveBeenCalled()
    expect(mockLogEvent).not.toHaveBeenCalled()
  })

  it('rejects with 400 when confirmCost has wrong text', async () => {
    const res = await POST(
      makeReq({ confirmCost: 'sure go ahead' }),
      { params: Promise.resolve({ id: 'sub_1' }) },
    )
    expect(res.status).toBe(400)
    expect(mockClassify).not.toHaveBeenCalled()
  })

  it('returns 404 when subscriber not found', async () => {
    mockSelect.mockReturnValue(selectChain([]))
    const res = await POST(
      makeReq({ confirmCost: COST_CONFIRMATION }),
      { params: Promise.resolve({ id: 'sub_missing' }) },
    )
    expect(res.status).toBe(404)
    expect(mockClassify).not.toHaveBeenCalled()
  })

  it('calls classifySubscriber with reconstructed signals + persists no row', async () => {
    // 1st select = subscriber row, 2nd select = email count.
    mockSelect
      .mockReturnValueOnce(selectChain([SUBSCRIBER_ROW]))
      .mockReturnValueOnce(selectChain([{ n: 2 }]))
    mockClassify.mockResolvedValue(FRESH_CLASSIFICATION)

    const res = await POST(
      makeReq({ confirmCost: COST_CONFIRMATION }),
      { params: Promise.resolve({ id: 'sub_1' }) },
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)

    expect(mockClassify).toHaveBeenCalledTimes(1)
    const [signals, ctx] = mockClassify.mock.calls[0]
    expect(signals.stripeCustomerId).toBe('cus_test')
    expect(signals.replyText).toBeNull()
    expect(signals.emailsSent).toBe(2)
    expect(ctx.founderName).toBe('Alex')
    expect(ctx.productName).toBe('Acme')

    // Crucially: no DB writes — only selects.
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('logs admin_action with action=classifier_re_run + cost', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([SUBSCRIBER_ROW]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]))
    mockClassify.mockResolvedValue(FRESH_CLASSIFICATION)

    await POST(
      makeReq({ confirmCost: COST_CONFIRMATION }),
      { params: Promise.resolve({ id: 'sub_1' }) },
    )

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'admin_action',
      userId: 'admin_user',
      customerId: 'cust_1',
      properties: expect.objectContaining({
        action: 'classifier_re_run',
        subscriberId: 'sub_1',
        costEstimate: 0.003,
        likelihoodShifted: true,  // stored 'high' vs fresh 'medium'
      }),
    }))
  })

  it('returns the diff payload (stored + fresh) for the UI to render', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([SUBSCRIBER_ROW]))
      .mockReturnValueOnce(selectChain([{ n: 0 }]))
    mockClassify.mockResolvedValue(FRESH_CLASSIFICATION)

    const res = await POST(
      makeReq({ confirmCost: COST_CONFIRMATION }),
      { params: Promise.resolve({ id: 'sub_1' }) },
    )
    const body = await res.json()
    expect(body.stored.tier).toBe(1)
    expect(body.stored.recoveryLikelihood).toBe('high')
    expect(body.fresh.tier).toBe(1)
    expect(body.fresh.recoveryLikelihood).toBe('medium')
    expect(body.fresh.handoffReasoning).toBe('(fresh)')
  })

  it('returns 401/403 from requireAdmin and does not call classifier', async () => {
    mockRequireAdmin.mockResolvedValueOnce({ error: 'Admin only', status: 403 })
    const res = await POST(
      makeReq({ confirmCost: COST_CONFIRMATION }),
      { params: Promise.resolve({ id: 'sub_1' }) },
    )
    expect(res.status).toBe(403)
    expect(mockClassify).not.toHaveBeenCalled()
  })
})
