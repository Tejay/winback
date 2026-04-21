import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SubscriberSignals } from '../lib/types'

// vi.hoisted ensures this runs before vi.mock factory
const mockCreate = vi.hoisted(() => vi.fn())
const mockCtor = vi.hoisted(() => vi.fn())

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
    constructor(opts: unknown) {
      mockCtor(opts)
    }
  },
}))

import { classifySubscriber, ClassificationSchema } from '../lib/classifier'

function makeSignals(overrides: Partial<SubscriberSignals> = {}): SubscriberSignals {
  return {
    stripeCustomerId: 'cus_test123',
    stripeSubscriptionId: 'sub_test123',
    stripePriceId: 'price_test123',
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
    process.env.ANTHROPIC_API_KEY = 'sk-test-key'
  })

  it('creates the Anthropic client with an API key', async () => {
    const signals = makeSignals()
    mockLLMResponse({
      tier: 3,
      tierReason: 't',
      cancellationReason: 'r',
      cancellationCategory: 'Other',
      confidence: 0.5,
      suppress: false,
      firstMessage: { subject: 's', body: 'b', sendDelaySecs: 60 },
      triggerKeyword: null,

      winBackSubject: 'w',
      winBackBody: 'b',
    })
    await classifySubscriber(signals, {})
    expect(mockCtor).toHaveBeenCalled()
    const opts = mockCtor.mock.calls[0][0] as { apiKey?: string }
    expect(opts.apiKey).toBe('sk-test-key')
  })

  it('includes reply_text in prompt when provided', async () => {
    const signals = makeSignals({ replyText: 'I left because the API was too slow' })
    mockLLMResponse({
      tier: 1,
      tierReason: 'Reply with explicit reason',
      cancellationReason: 'API too slow',
      cancellationCategory: 'Quality',
      confidence: 0.95,
      suppress: false,
      firstMessage: { subject: 'About the API speed', body: 'We heard you...', sendDelaySecs: 60 },
      triggerKeyword: 'api speed',

      winBackSubject: 'API just got faster',
      winBackBody: 'We rebuilt the API...',
    })
    await classifySubscriber(signals, {})
    const userPrompt = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(userPrompt).toContain('reply_text: I left because the API was too slow')
    expect(userPrompt).not.toContain('reply_text: not_provided')
  })

  it('defaults reply_text to not_provided when absent', async () => {
    const signals = makeSignals()
    mockLLMResponse({
      tier: 3, tierReason: 't', cancellationReason: 'r', cancellationCategory: 'Other',
      confidence: 0.5, suppress: false,
      firstMessage: { subject: 's', body: 'b', sendDelaySecs: 60 },
      triggerKeyword: null, winBackSubject: 'w', winBackBody: 'b',
    })
    await classifySubscriber(signals, {})
    const userPrompt = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(userPrompt).toContain('reply_text: not_provided')
  })

  it('includes billing_portal_clicked in prompt', async () => {
    const signals = makeSignals({ billingPortalClicked: true })
    mockLLMResponse({
      tier: 1, tierReason: 't', cancellationReason: 'r', cancellationCategory: 'Other',
      confidence: 0.8, suppress: false,
      firstMessage: { subject: 's', body: 'b', sendDelaySecs: 60 },
      triggerKeyword: null, winBackSubject: 'w', winBackBody: 'b',
    })
    await classifySubscriber(signals, {})
    const userPrompt = mockCreate.mock.calls[0][0].messages[0].content as string
    expect(userPrompt).toContain('billing_portal_clicked: true')
  })

  it('system prompt contains the tightened MESSAGE WRITING constraints', async () => {
    const signals = makeSignals()
    mockLLMResponse({
      tier: 3, tierReason: 't', cancellationReason: 'r', cancellationCategory: 'Other',
      confidence: 0.5, suppress: false,
      firstMessage: { subject: 's', body: 'b', sendDelaySecs: 60 },
      triggerKeyword: null, winBackSubject: 'w', winBackBody: 'b',
    })
    await classifySubscriber(signals, {})
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    // Section headers we rely on — if these disappear, tone regresses silently.
    expect(systemPrompt).toContain('MESSAGE WRITING')
    expect(systemPrompt).toContain('Banned phrases')
    expect(systemPrompt).toContain('RESULT FOCUS')
    // Length constraint must be explicit.
    expect(systemPrompt).toMatch(/2 or 3 complete sentences/)
    // Representative banned phrases must be spelled out verbatim.
    expect(systemPrompt.toLowerCase()).toContain('just checking in')
    expect(systemPrompt.toLowerCase()).toContain("we'd love to have you back")
    expect(systemPrompt.toLowerCase()).toContain('limited time')
    // No exclamation marks rule must be present.
    expect(systemPrompt).toMatch(/no exclamation marks/i)
  })

  it('includes re-classification rules in system prompt when reply_text present', async () => {
    const signals = makeSignals({ replyText: 'Some reply' })
    mockLLMResponse({
      tier: 1, tierReason: 't', cancellationReason: 'r', cancellationCategory: 'Other',
      confidence: 0.9, suppress: false,
      firstMessage: { subject: 's', body: 'b', sendDelaySecs: 60 },
      triggerKeyword: null, winBackSubject: 'w', winBackBody: 'b',
    })
    await classifySubscriber(signals, {})
    const systemPrompt = mockCreate.mock.calls[0][0].system as string
    expect(systemPrompt).toContain('RE-CLASSIFICATION')
    expect(systemPrompt).toContain('highest-signal input')
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
      winBackSubject: 'A lot has changed since you left',
      winBackBody: 'Hi Test User,\n\nWe have been busy shipping improvements...',
    })

    const result = await classifySubscriber(signals, {})
    expect(result.tier).toBe(3)
    expect(result.confidence).toBeLessThanOrEqual(0.70)
    // Tier 3 must NOT reference a specific exit reason
    expect(result.firstMessage?.body).not.toMatch(/too expensive|competitor|feature|quality/i)
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
      winBackSubject: '',
      winBackBody: '',
    })

    const result = await classifySubscriber(signals, {})
    expect(result.suppress).toBe(true)
    expect(result.tier).toBe(4)
    expect(ClassificationSchema.safeParse(result).success).toBe(true)
  })
})
