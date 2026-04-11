import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubscriberSignals } from '../lib/types'

// vi.hoisted ensures this runs before vi.mock factory
const mockCreate = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import { classifySubscriber, ClassificationSchema } from '../lib/classifier'

function makeSignals(overrides: Partial<SubscriberSignals> = {}): SubscriberSignals {
  return {
    stripeCustomerId: 'cus_test123',
    email: 'test@example.com',
    name: 'Test User',
    planName: 'Pro',
    mrrCents: 2499,
    tenureDays: 120,
    everUpgraded: false,
    nearRenewal: false,
    paymentFailures: 0,
    previousSubs: 0,
    stripeEnum: null,
    stripeComment: null,
    cancelledAt: new Date('2024-01-15'),
    ...overrides,
  }
}

function mockLLMResponse(response: object) {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: JSON.stringify(response) }],
  })
}

describe('classifySubscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Scenario A — Tier 1, feature complaint in stripe_comment', async () => {
    const signals = makeSignals({
      stripeComment: 'I needed a Zapier integration to connect to my CRM',
    })

    mockLLMResponse({
      tier: 1,
      tierReason: 'Explicit feature request in cancellation comment',
      cancellationReason: 'Needed Zapier integration',
      cancellationCategory: 'Feature',
      confidence: 0.92,
      suppress: false,
      firstMessage: {
        subject: 'About that Zapier integration',
        body: 'Hi Test User,\n\nI saw you cancelled because you needed a Zapier integration...',
        sendDelaySecs: 60,
      },
      triggerKeyword: 'zapier',
      fallbackDays: 90,
      winBackSubject: 'We just shipped Zapier integration',
      winBackBody: 'Hi Test User,\n\nRemember when you mentioned needing Zapier?...',
    })

    const result = await classifySubscriber(signals, { productName: 'Acme' })
    expect(result.tier).toBe(1)
    expect(result.confidence).toBeGreaterThanOrEqual(0.85)
    expect(result.triggerKeyword).toContain('zapier')
    expect(ClassificationSchema.safeParse(result).success).toBe(true)
  })

  it('Scenario B — Tier 1, email reply with feature request', async () => {
    const signals = makeSignals({
      stripeComment: 'The CSV export was too limited',
    })

    mockLLMResponse({
      tier: 1,
      tierReason: 'Explicit feature limitation in comment',
      cancellationReason: 'CSV export too limited',
      cancellationCategory: 'Feature',
      confidence: 0.90,
      suppress: false,
      firstMessage: {
        subject: 'About the CSV export',
        body: 'Hi Test User,\n\nI noticed you left because the CSV export...',
        sendDelaySecs: 60,
      },
      triggerKeyword: 'csv export',
      fallbackDays: 90,
      winBackSubject: 'CSV export just got a major upgrade',
      winBackBody: 'Hi Test User,\n\nWe rebuilt CSV export from scratch...',
    })

    const result = await classifySubscriber(signals, {})
    expect(result.tier).toBe(1)
    expect(result.confidence).toBeGreaterThanOrEqual(0.90)
    expect(result.triggerKeyword).toMatch(/csv|export/)
    expect(ClassificationSchema.safeParse(result).success).toBe(true)
  })

  it('Scenario C — Tier 2, enum only (too_expensive)', async () => {
    const signals = makeSignals({
      stripeEnum: 'too_expensive',
      stripeComment: null,
    })

    mockLLMResponse({
      tier: 2,
      tierReason: 'Stripe enum indicates price concern but no detail',
      cancellationReason: 'Found too expensive',
      cancellationCategory: 'Price',
      confidence: 0.65,
      suppress: false,
      firstMessage: {
        subject: 'Quick question about your experience',
        body: 'Hi Test User,\n\nI noticed you cancelled your Pro plan. Would you mind sharing what happened? Hit reply — one line is enough.',
        sendDelaySecs: 60,
      },
      triggerKeyword: null,
      fallbackDays: 30,
      winBackSubject: 'New pricing that might work better',
      winBackBody: 'Hi Test User,\n\nWe recently adjusted our pricing...',
    })

    const result = await classifySubscriber(signals, {})
    expect(result.tier).toBe(2)
    expect(result.confidence).toBeGreaterThanOrEqual(0.50)
    expect(result.confidence).toBeLessThanOrEqual(0.75)
    expect(result.cancellationCategory).toBe('Price')
    expect(ClassificationSchema.safeParse(result).success).toBe(true)
  })

  it('Scenario D — Tier 3, long tenure, silent churn', async () => {
    const signals = makeSignals({
      tenureDays: 280,
      everUpgraded: true,
      stripeEnum: null,
      stripeComment: null,
    })

    mockLLMResponse({
      tier: 3,
      tierReason: 'No cancellation reason provided, relying on billing signals only',
      cancellationReason: 'No reason given',
      cancellationCategory: 'Other',
      confidence: 0.45,
      suppress: false,
      firstMessage: {
        subject: 'Noticed you left',
        body: 'Hi Test User,\n\nI saw your subscription ended after almost a year with us. We appreciate the time you spent. Would you mind sharing what happened? Hit reply — one line is enough.',
        sendDelaySecs: 60,
      },
      triggerKeyword: null,
      fallbackDays: 180,
      winBackSubject: 'A lot has changed since you left',
      winBackBody: 'Hi Test User,\n\nWe have been busy shipping improvements...',
    })

    const result = await classifySubscriber(signals, {})
    expect(result.tier).toBe(3)
    expect(result.confidence).toBeLessThanOrEqual(0.70)
    // Tier 3 must NOT reference a specific exit reason
    expect(result.firstMessage.body).not.toMatch(/too expensive|competitor|feature|quality/i)
    expect(ClassificationSchema.safeParse(result).success).toBe(true)
  })

  it('Scenario E — Tier 4, suppress (no email, short tenure)', async () => {
    const signals = makeSignals({
      email: null,
      tenureDays: 2,
    })

    mockLLMResponse({
      tier: 4,
      tierReason: 'No email address and very short tenure — likely test account',
      cancellationReason: 'Test/spam account',
      cancellationCategory: 'Other',
      confidence: 0.95,
      suppress: true,
      suppressReason: 'No email address available, tenure under 5 days',
      firstMessage: {
        subject: '',
        body: '',
        sendDelaySecs: 0,
      },
      triggerKeyword: null,
      fallbackDays: 180,
      winBackSubject: '',
      winBackBody: '',
    })

    const result = await classifySubscriber(signals, {})
    expect(result.suppress).toBe(true)
    expect(result.tier).toBe(4)
    expect(ClassificationSchema.safeParse(result).success).toBe(true)
  })
})
