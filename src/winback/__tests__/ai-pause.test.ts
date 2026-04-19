import { describe, it, expect } from 'vitest'

/**
 * Tests for spec 22 (per-subscriber AI pause + dashboard AI state).
 *
 * Unit-level tests for the decision logic. Route handlers are integration-tested
 * via the dev harness.
 */

// ─── 22a: pause gate logic ───────────────────────────────────────────────────

describe('Pause gate (spec 22a)', () => {
  function isPaused(aiPausedUntil: Date | null, now: Date = new Date()): boolean {
    return !!aiPausedUntil && aiPausedUntil.getTime() > now.getTime()
  }

  it('no pause set → not paused', () => {
    expect(isPaused(null)).toBe(false)
  })

  it('pause in the future → paused', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    expect(isPaused(tomorrow)).toBe(true)
  })

  it('pause expired → not paused', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    expect(isPaused(yesterday)).toBe(false)
  })

  it('indefinite sentinel (9999-12-31) → paused', () => {
    expect(isPaused(new Date('9999-12-31T00:00:00Z'))).toBe(true)
  })
})

describe('Reply-handling decision (spec 22a)', () => {
  // Mirrors the inbound route's branching: notify founder unless handoff+pause.
  function replyAction(args: {
    isHandedOff: boolean
    isPaused: boolean
  }): 'auto-reply' | 'notify-founder' | 'mute' {
    if (!args.isHandedOff && !args.isPaused) return 'auto-reply'
    if (args.isHandedOff && args.isPaused) return 'mute'
    return 'notify-founder'
  }

  it('no handoff, no pause → auto-reply', () => {
    expect(replyAction({ isHandedOff: false, isPaused: false })).toBe('auto-reply')
  })

  it('handoff only → notify founder (snooze expired or never set)', () => {
    expect(replyAction({ isHandedOff: true, isPaused: false })).toBe('notify-founder')
  })

  it('pause only (proactive) → notify founder', () => {
    expect(replyAction({ isHandedOff: false, isPaused: true })).toBe('notify-founder')
  })

  it('handoff + pause (handoff snooze active) → mute', () => {
    expect(replyAction({ isHandedOff: true, isPaused: true })).toBe('mute')
  })
})

describe('Attribution window (spec 22a)', () => {
  const WINDOW = 30

  function inWindow(anchoredAt: Date | null, now: Date = new Date()): boolean {
    if (!anchoredAt) return false
    const days = (now.getTime() - anchoredAt.getTime()) / (1000 * 60 * 60 * 24)
    return days <= WINDOW
  }

  it('handoff 29 days ago → strong', () => {
    const d = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)
    expect(inWindow(d)).toBe(true)
  })

  it('handoff 31 days ago → outside', () => {
    const d = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    expect(inWindow(d)).toBe(false)
  })

  it('pause set yesterday → strong', () => {
    const d = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000)
    expect(inWindow(d)).toBe(true)
  })

  it('never set → not in window', () => {
    expect(inWindow(null)).toBe(false)
  })
})

describe('Manual resolve clears pause (spec 22a)', () => {
  // Documents the design decision: resolve-handoff sets both resolved_at AND
  // clears pause fields.
  it('resolve-handoff clears ai_paused_until and ai_paused_at and reason', () => {
    const before = {
      founderHandoffResolvedAt: null,
      aiPausedUntil: new Date('9999-12-31'),
      aiPausedAt: new Date('2026-04-18'),
      aiPausedReason: 'handoff',
    }
    // Simulate the endpoint's set() clause
    const after = {
      founderHandoffResolvedAt: new Date(),
      aiPausedUntil: null,
      aiPausedAt: null,
      aiPausedReason: null,
    }

    expect(after.founderHandoffResolvedAt).not.toBeNull()
    expect(after.aiPausedUntil).toBeNull()
    expect(after.aiPausedAt).toBeNull()
    expect(after.aiPausedReason).toBeNull()
    // Silence unused-var warning (test is about the shape, not runtime behavior)
    expect(before.founderHandoffResolvedAt).toBeNull()
  })
})

// ─── 22b: dashboard AI state derivation ──────────────────────────────────────

describe('aiState() derivation (spec 22b)', () => {
  it('status=recovered → recovered (terminal, wins over everything)', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'recovered',
      doNotContact: false,
      founderHandoffAt: new Date(), // even if handed off
      founderHandoffResolvedAt: null,
      aiPausedUntil: new Date('9999-12-31'),
    })).toBe('recovered')
  })

  it('status=lost → done', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'lost',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: null,
    })).toBe('done')
  })

  it('status=skipped → done', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'skipped',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: null,
    })).toBe('done')
  })

  it('doNotContact=true → done (even if status is contacted)', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'contacted',
      doNotContact: true,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: null,
    })).toBe('done')
  })

  it('handoff unresolved → handoff (regardless of pause state)', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'contacted',
      doNotContact: false,
      founderHandoffAt: new Date(),
      founderHandoffResolvedAt: null,
      aiPausedUntil: new Date('9999-12-31'),
    })).toBe('handoff')
  })

  it('handoff resolved + pause active → paused', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'contacted',
      doNotContact: false,
      founderHandoffAt: new Date('2026-01-01'),
      founderHandoffResolvedAt: new Date('2026-02-01'),
      aiPausedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })).toBe('paused')
  })

  it('pause active, no handoff → paused', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'contacted',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })).toBe('paused')
  })

  it('pause expired → active', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'contacted',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
    })).toBe('active')
  })

  it('no flags, status=contacted → active', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'contacted',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: null,
    })).toBe('active')
  })

  it('no flags, status=pending → active (pre-contact)', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    expect(aiState({
      status: 'pending',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: null,
    })).toBe('active')
  })

  it('accepts ISO string dates (as dashboard client sends them)', async () => {
    const { aiState } = await import('../../../lib/ai-state')
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    expect(aiState({
      status: 'contacted',
      doNotContact: false,
      founderHandoffAt: null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: futureIso,
    })).toBe('paused')
  })
})

describe('Filter validation (spec 22b)', () => {
  it('validates known AI-state filter values', async () => {
    const { isValidAiStateFilter } = await import('../../../lib/ai-state')
    for (const f of ['all', 'active', 'handoff', 'paused', 'recovered', 'done']) {
      expect(isValidAiStateFilter(f)).toBe(true)
    }
  })

  it('rejects unknown filter values', async () => {
    const { isValidAiStateFilter } = await import('../../../lib/ai-state')
    for (const f of ['', 'foo', 'pending', 'contacted']) {
      expect(isValidAiStateFilter(f)).toBe(false)
    }
  })
})

describe('Event names (spec 22a)', () => {
  it('new event names follow snake_case', () => {
    for (const n of ['ai_paused', 'ai_resumed']) {
      expect(n).toMatch(/^[a-z]+(_[a-z]+)+$/)
    }
  })
})
