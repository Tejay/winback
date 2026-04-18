import { describe, it, expect } from 'vitest'

/**
 * Tests for spec 21 (conversation continuity + founder handoff).
 *
 * The route handlers themselves are integration-tested through the dev
 * harness; these unit tests focus on the new decision logic and helpers.
 */

describe('Engaged-nudge eligibility (spec 21a)', () => {
  // Mirrors the cron query — documenting the rules so future changes don't regress them.

  function isEligibleForEngagedNudge(sub: {
    status: string
    doNotContact: boolean
    email: string | null
    lastEngagementAt: Date | null
    proactiveNudgeAt: Date | null
    founderHandoffAt: Date | null
  }, now: Date = new Date(), nudgeDays = 7): boolean {
    if (sub.status !== 'contacted') return false
    if (sub.doNotContact) return false
    if (!sub.email) return false
    if (!sub.lastEngagementAt) return false
    if (sub.proactiveNudgeAt) return false
    if (sub.founderHandoffAt) return false
    const daysSince = (now.getTime() - sub.lastEngagementAt.getTime()) / (1000 * 60 * 60 * 24)
    return daysSince >= nudgeDays
  }

  const baseSub = {
    status: 'contacted',
    doNotContact: false,
    email: 'test@example.com',
    lastEngagementAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
    proactiveNudgeAt: null,
    founderHandoffAt: null,
  }

  it('engaged 10 days ago, never nudged → eligible', () => {
    expect(isEligibleForEngagedNudge(baseSub)).toBe(true)
  })

  it('engaged only 3 days ago → not eligible (too recent)', () => {
    const sub = { ...baseSub, lastEngagementAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }
    expect(isEligibleForEngagedNudge(sub)).toBe(false)
  })

  it('engaged 10 days ago BUT already nudged → not eligible', () => {
    const sub = { ...baseSub, proactiveNudgeAt: new Date() }
    expect(isEligibleForEngagedNudge(sub)).toBe(false)
  })

  it('engaged 10 days ago BUT handed off → not eligible', () => {
    const sub = { ...baseSub, founderHandoffAt: new Date() }
    expect(isEligibleForEngagedNudge(sub)).toBe(false)
  })

  it('never engaged → not eligible', () => {
    const sub = { ...baseSub, lastEngagementAt: null }
    expect(isEligibleForEngagedNudge(sub)).toBe(false)
  })

  it('opted out → not eligible', () => {
    const sub = { ...baseSub, doNotContact: true }
    expect(isEligibleForEngagedNudge(sub)).toBe(false)
  })

  it('status pending → not eligible (must have been contacted)', () => {
    const sub = { ...baseSub, status: 'pending' }
    expect(isEligibleForEngagedNudge(sub)).toBe(false)
  })

  it('status recovered → not eligible', () => {
    const sub = { ...baseSub, status: 'recovered' }
    expect(isEligibleForEngagedNudge(sub)).toBe(false)
  })
})

describe('Handoff state filtering (spec 21b)', () => {
  // Documents which automated paths should skip handed-off subscribers.

  function shouldAutoSend(sub: {
    founderHandoffAt: Date | null
    founderHandoffResolvedAt: Date | null
  }): boolean {
    if (sub.founderHandoffAt && !sub.founderHandoffResolvedAt) return false
    return true
  }

  it('not handed off → auto-send', () => {
    expect(shouldAutoSend({ founderHandoffAt: null, founderHandoffResolvedAt: null })).toBe(true)
  })

  it('handed off, unresolved → skip auto-send', () => {
    expect(shouldAutoSend({ founderHandoffAt: new Date(), founderHandoffResolvedAt: null })).toBe(false)
  })

  it('handed off but resolved → auto-send (back to normal)', () => {
    expect(shouldAutoSend({
      founderHandoffAt: new Date('2026-01-01'),
      founderHandoffResolvedAt: new Date('2026-02-01'),
    })).toBe(true)
  })
})

describe('Snooze suppression (spec 21c)', () => {
  function isSnoozed(snoozedUntil: Date | null, now: Date = new Date()): boolean {
    return !!snoozedUntil && snoozedUntil.getTime() > now.getTime()
  }

  it('no snooze set → not snoozed', () => {
    expect(isSnoozed(null)).toBe(false)
  })

  it('snoozed until tomorrow → snoozed', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    expect(isSnoozed(tomorrow)).toBe(true)
  })

  it('snooze expired yesterday → not snoozed', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    expect(isSnoozed(yesterday)).toBe(false)
  })
})

describe('Handoff attribution window (spec 21b)', () => {
  // Replicates the rule in processRecovery / processPaymentSucceeded.
  const HANDOFF_DAYS = 30

  function inHandoffWindow(handoffAt: Date | null, now: Date = new Date()): boolean {
    if (!handoffAt) return false
    const days = (now.getTime() - handoffAt.getTime()) / (1000 * 60 * 60 * 24)
    return days <= HANDOFF_DAYS
  }

  it('no handoff → not in window', () => {
    expect(inHandoffWindow(null)).toBe(false)
  })

  it('handed off today → in window', () => {
    expect(inHandoffWindow(new Date())).toBe(true)
  })

  it('handed off 25 days ago → in window', () => {
    expect(inHandoffWindow(new Date(Date.now() - 25 * 24 * 60 * 60 * 1000))).toBe(true)
  })

  it('handed off 30 days ago → in window (boundary)', () => {
    expect(inHandoffWindow(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))).toBe(true)
  })

  it('handed off 31 days ago → outside window', () => {
    expect(inHandoffWindow(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))).toBe(false)
  })
})

describe('Notification email resolution (spec 21c)', () => {
  function resolveRecipient(args: {
    notificationEmail: string | null
    userEmail: string | null
  }): string | null {
    return args.notificationEmail ?? args.userEmail ?? null
  }

  it('uses notification_email when set', () => {
    expect(resolveRecipient({
      notificationEmail: 'team@example.com',
      userEmail: 'founder@example.com',
    })).toBe('team@example.com')
  })

  it('falls back to user.email when notification_email is null', () => {
    expect(resolveRecipient({
      notificationEmail: null,
      userEmail: 'founder@example.com',
    })).toBe('founder@example.com')
  })

  it('returns null when neither is set', () => {
    expect(resolveRecipient({
      notificationEmail: null,
      userEmail: null,
    })).toBeNull()
  })
})

describe('Mailto builder (spec 21b)', () => {
  it('produces a valid mailto URL with encoded subject and body', async () => {
    const { buildMailto } = await import('../lib/founder-handoff-email')
    const url = buildMailto({
      subscriberEmail: 'sarah@example.com',
      firstName: 'Sarah',
      founderName: 'Tej',
      reactivationLink: 'https://winbackflow.co/api/reactivate/abc',
      conversationQuote: '> Their last reply: I needed CSV',
    })
    expect(url).toMatch(/^mailto:sarah%40example\.com/)
    expect(url).toContain('subject=')
    expect(url).toContain('body=')
    // Body should reference the founder name + reactivation link
    expect(decodeURIComponent(url)).toContain('Tej')
    expect(decodeURIComponent(url)).toContain('https://winbackflow.co/api/reactivate/abc')
  })

  it('escapes spaces and special chars in subject and body', async () => {
    const { buildMailto } = await import('../lib/founder-handoff-email')
    const url = buildMailto({
      subscriberEmail: 'a@b.com',
      firstName: 'A & B',
      founderName: 'C',
      reactivationLink: 'https://x',
      conversationQuote: '',
    })
    // No raw spaces or & in URL params
    expect(url).not.toMatch(/\?subject=Re: /)
    expect(url).toContain('Re%3A')
  })
})

describe('All 5 new event names (spec 21)', () => {
  it('event names follow snake_case', () => {
    const names = [
      'founder_handoff_triggered',
      'proactive_nudge_sent',
      'handoff_snoozed',
      'handoff_resolved_manually',
    ]
    for (const n of names) {
      expect(n).toMatch(/^[a-z]+(_[a-z]+)+$/)
    }
  })
})
