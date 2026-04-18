import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Anthropic SDK BEFORE importing the module under test
const mockCreate = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import {
  matchChangelogToSubscribers,
  generateWinBackEmail,
  MAX_BATCH_SIZE,
} from '../lib/changelog-match'

function mockLLMResponse(text: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text }],
  })
}

beforeEach(() => {
  mockCreate.mockReset()
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
})

describe('matchChangelogToSubscribers', () => {
  it('returns empty Set when no candidates given (no LLM call)', async () => {
    const result = await matchChangelogToSubscribers('changelog', [])
    expect(result.size).toBe(0)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns IDs marked true by the LLM', async () => {
    mockLLMResponse('{"a": true, "b": false, "c": true}')

    const result = await matchChangelogToSubscribers('Slack alerts shipped', [
      { id: 'a', need: 'wants slack' },
      { id: 'b', need: 'wants zapier' },
      { id: 'c', need: 'wants notifications' },
    ])

    expect(result.size).toBe(2)
    expect(result.has('a')).toBe(true)
    expect(result.has('b')).toBe(false)
    expect(result.has('c')).toBe(true)
  })

  it('handles markdown code fences in LLM response', async () => {
    mockLLMResponse('```json\n{"x": true}\n```')
    const result = await matchChangelogToSubscribers('changelog', [
      { id: 'x', need: 'something' },
    ])
    expect(result.has('x')).toBe(true)
  })

  it('returns empty Set on JSON parse failure', async () => {
    mockLLMResponse('not valid json {{')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await matchChangelogToSubscribers('changelog', [
      { id: 'a', need: 'something' },
    ])

    expect(result.size).toBe(0)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('returns empty Set on Zod validation failure (wrong shape)', async () => {
    mockLLMResponse('{"a": "not a boolean"}')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await matchChangelogToSubscribers('changelog', [
      { id: 'a', need: 'something' },
    ])

    expect(result.size).toBe(0)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('returns empty Set on LLM API failure (fail closed)', async () => {
    mockCreate.mockRejectedValue(new Error('API down'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await matchChangelogToSubscribers('changelog', [
      { id: 'a', need: 'something' },
    ])

    expect(result.size).toBe(0)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('passes changelog and candidate needs to the LLM prompt', async () => {
    mockLLMResponse('{"a": true}')
    await matchChangelogToSubscribers('Shipped CSV export', [
      { id: 'a', need: 'wants spreadsheet downloads' },
    ])

    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].content).toContain('Shipped CSV export')
    expect(call.messages[0].content).toContain('wants spreadsheet downloads')
    expect(call.messages[0].content).toContain('id=a')
    expect(call.temperature).toBe(0)
  })

  it('uses claude-haiku-4-5 model', async () => {
    mockLLMResponse('{"a": true}')
    await matchChangelogToSubscribers('changelog', [{ id: 'a', need: 'x' }])

    const call = mockCreate.mock.calls[0][0]
    expect(call.model).toMatch(/^claude-haiku-4-5/)
  })

  it('chunks batches when candidates exceed MAX_BATCH_SIZE', async () => {
    // Create one more than the batch size
    const candidates = Array.from({ length: MAX_BATCH_SIZE + 5 }, (_, i) => ({
      id: `id-${i}`,
      need: `need ${i}`,
    }))

    // Each batch returns true for the first id
    mockCreate.mockImplementation(() =>
      Promise.resolve({
        content: [{ type: 'text', text: '{"id-0": true}' }],
      })
    )

    await matchChangelogToSubscribers('changelog', candidates)

    // Should have made 2 calls (one for batch of MAX_BATCH_SIZE, one for remaining 5)
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('strict matcher: synonym/paraphrase example', async () => {
    // The point of the spec — "csv export" need vs "spreadsheet downloads" changelog
    // The LLM is what makes this work; we just verify the wiring passes the right data
    mockLLMResponse('{"bob": true}')

    const result = await matchChangelogToSubscribers(
      'We shipped spreadsheet downloads this week',
      [{ id: 'bob', need: 'csv export for accountant' }]
    )

    expect(result.has('bob')).toBe(true)
    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].content).toContain('spreadsheet downloads')
    expect(call.messages[0].content).toContain('csv export for accountant')
  })

  it('strict matcher: false positive avoidance', async () => {
    // "happy" keyword shouldn't match "happy path" — the LLM understands context
    mockLLMResponse('{"dave": false}')

    const result = await matchChangelogToSubscribers(
      'Fixed the happy path of onboarding',
      [{ id: 'dave', need: 'wants happy customers feature' }]
    )

    expect(result.has('dave')).toBe(false)
    expect(result.size).toBe(0)
  })
})

describe('generateWinBackEmail', () => {
  it('returns subject + body from valid LLM JSON', async () => {
    mockLLMResponse('{"subject": "CSV is ready", "body": "Hi Bob, you wanted CSV export. We shipped it. Want to try?"}')

    const result = await generateWinBackEmail({
      changelogText: 'Shipped CSV export',
      triggerNeed: 'csv export for accountant',
      subscriberName: 'Bob Smith',
      founderName: 'Tej',
    })

    expect(result).not.toBeNull()
    expect(result!.subject).toBe('CSV is ready')
    expect(result!.body).toContain('CSV')
  })

  it('passes subscriber name and founder name to LLM', async () => {
    mockLLMResponse('{"subject": "S", "body": "B"}')

    await generateWinBackEmail({
      changelogText: 'changelog',
      triggerNeed: 'need',
      subscriberName: 'Alice Jones',
      founderName: 'Tej',
    })

    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].content).toContain('Alice')
    expect(call.messages[0].content).toContain('Tej')
  })

  it('uses "there" as first name fallback when subscriber name is null', async () => {
    mockLLMResponse('{"subject": "S", "body": "B"}')

    await generateWinBackEmail({
      changelogText: 'changelog',
      triggerNeed: 'need',
      subscriberName: null,
      founderName: 'Tej',
    })

    const call = mockCreate.mock.calls[0][0]
    expect(call.messages[0].content).toContain('there')
  })

  it('returns null on LLM failure (caller should skip sending)', async () => {
    mockCreate.mockRejectedValue(new Error('API down'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateWinBackEmail({
      changelogText: 'changelog',
      triggerNeed: 'need',
      subscriberName: 'Bob',
      founderName: 'Tej',
    })

    expect(result).toBeNull()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })

  it('returns null on JSON parse failure', async () => {
    mockLLMResponse('not json')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateWinBackEmail({
      changelogText: 'changelog',
      triggerNeed: 'need',
      subscriberName: 'Bob',
      founderName: 'Tej',
    })

    expect(result).toBeNull()
    consoleSpy.mockRestore()
  })

  it('returns null when LLM returns empty subject (Zod validation)', async () => {
    mockLLMResponse('{"subject": "", "body": "Hi"}')
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await generateWinBackEmail({
      changelogText: 'changelog',
      triggerNeed: 'need',
      subscriberName: 'Bob',
      founderName: 'Tej',
    })

    expect(result).toBeNull()
    consoleSpy.mockRestore()
  })

  it('handles markdown code fences', async () => {
    mockLLMResponse('```json\n{"subject": "S", "body": "B"}\n```')

    const result = await generateWinBackEmail({
      changelogText: 'c',
      triggerNeed: 'n',
      subscriberName: 'Bob',
      founderName: 'Tej',
    })

    expect(result?.subject).toBe('S')
  })

  it('uses claude-haiku-4-5 model with non-zero temperature for variety', async () => {
    mockLLMResponse('{"subject": "S", "body": "B"}')

    await generateWinBackEmail({
      changelogText: 'c',
      triggerNeed: 'n',
      subscriberName: 'Bob',
      founderName: 'Tej',
    })

    const call = mockCreate.mock.calls[0][0]
    expect(call.model).toMatch(/^claude-haiku-4-5/)
    // Slight temperature lets the email feel less robotic
    expect(call.temperature).toBeGreaterThan(0)
  })
})
