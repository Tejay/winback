/**
 * Spec 71 — buildConversationThread + renderThreadForPrompt unit tests.
 *
 * The builder is the canonical source the classifier reads from, so we
 * verify chronological ordering, the 10-turn cap, and the per-turn
 * body truncation. renderThreadForPrompt is plain-formatting and tested
 * separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  emailsSent: {
    subscriberId: 'subscriber_id',
    sentAt: 'sent_at',
    id: 'id', type: 'type', subject: 'subject', bodyText: 'body_text',
  },
  subscriberReplies: {
    subscriberId: 'subscriber_id',
    receivedAt: 'received_at',
    id: 'id', body: 'body',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq:   vi.fn((a, b) => ({ eq: [a, b] })),
  asc:  vi.fn((c) => ({ asc: c })),
  desc: vi.fn((c) => ({ desc: c })),
}))

import {
  buildConversationThread,
  renderThreadForPrompt,
  getLatestReply,
} from '../lib/conversation'

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve),
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildConversationThread', () => {
  it('merges outbound + reply rows in chronological order', async () => {
    mockSelect
      .mockReturnValueOnce(selectChain([
        { id: 'e1', type: 'exit', subject: 'Sorry to see you go', bodyText: 'We just shipped X.', sentAt: new Date('2026-01-01') },
        { id: 'e2', type: 'followup', subject: 'About pricing', bodyText: 'Would a discount help?', sentAt: new Date('2026-01-05') },
      ]))
      .mockReturnValueOnce(selectChain([
        { id: 'r1', body: 'thanks but no', receivedAt: new Date('2026-01-03') },
        { id: 'r2', body: 'we moved to FooCorp', receivedAt: new Date('2026-01-07') },
      ]))
    const thread = await buildConversationThread('sub_1')
    expect(thread.map((t) => t.kind)).toEqual(['outbound', 'reply', 'outbound', 'reply'])
    expect(thread[1].body).toBe('thanks but no')
    expect(thread[3].body).toBe('we moved to FooCorp')
  })

  it('caps at the most-recent 10 turns', async () => {
    const outbound = Array.from({ length: 8 }, (_, i) => ({
      id: `e${i}`, type: 'reengagement', subject: `s${i}`, bodyText: `b${i}`,
      sentAt: new Date(2026, 0, 1 + i * 2),
    }))
    const replies = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`, body: `reply ${i}`,
      receivedAt: new Date(2026, 0, 2 + i * 2),
    }))
    mockSelect
      .mockReturnValueOnce(selectChain(outbound))
      .mockReturnValueOnce(selectChain(replies))
    const thread = await buildConversationThread('sub_1')
    expect(thread).toHaveLength(10)
    // First kept item should be the 7th-most-recent of 16
    // 16 - 10 = 6 turns dropped from the front
    expect(thread[thread.length - 1].body).toBe('reply 7')
  })

  it('truncates per-turn body at maxBodyChars and flags truncated:true', async () => {
    const longBody = 'x'.repeat(5000)
    mockSelect
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        { id: 'r1', body: longBody, receivedAt: new Date('2026-01-01') },
      ]))
    const thread = await buildConversationThread('sub_1', { maxBodyChars: 100 })
    expect(thread).toHaveLength(1)
    expect(thread[0].body.length).toBe(100)
    expect(thread[0].truncated).toBe(true)
  })
})

describe('renderThreadForPrompt', () => {
  it('renders empty string for empty / undefined thread', () => {
    expect(renderThreadForPrompt(undefined)).toBe('')
    expect(renderThreadForPrompt([])).toBe('')
  })

  it('produces a labeled block with outbound + reply turns', () => {
    const out = renderThreadForPrompt([
      { kind: 'outbound', at: new Date('2026-01-01'), emailType: 'exit', subject: 'Sorry to see you go', body: 'We just shipped X.' },
      { kind: 'reply',    at: new Date('2026-01-03'), body: 'thanks but no' },
    ], new Date('2026-01-01'))
    expect(out).toContain('CONVERSATION SO FAR')
    expect(out).toContain('WE SENT (exit)')
    expect(out).toContain('SUBSCRIBER REPLIED')
    expect(out).toContain('thanks but no')
  })

  it('marks truncated bodies inline', () => {
    const out = renderThreadForPrompt([
      { kind: 'reply', at: new Date(), body: 'long reply', truncated: true },
    ])
    expect(out).toContain('…[truncated]')
  })
})

describe('getLatestReply', () => {
  it('returns the body of the most recent reply', async () => {
    mockSelect.mockReturnValueOnce(selectChain([{ body: 'most recent' }]))
    const reply = await getLatestReply('sub_1')
    expect(reply).toBe('most recent')
  })

  it('returns null when there are no replies', async () => {
    mockSelect.mockReturnValueOnce(selectChain([]))
    const reply = await getLatestReply('sub_1')
    expect(reply).toBeNull()
  })
})
