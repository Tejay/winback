import { describe, it, expect } from 'vitest'
import { stripQuotedReply } from '../lib/strip-quoted-reply'

describe('stripQuotedReply', () => {
  it('returns empty for null/undefined/empty', () => {
    expect(stripQuotedReply(null)).toBe('')
    expect(stripQuotedReply(undefined)).toBe('')
    expect(stripQuotedReply('')).toBe('')
  })

  it('keeps a plain reply with no quote untouched', () => {
    expect(stripQuotedReply('If you ship Slack I might come back.')).toBe(
      'If you ship Slack I might come back.',
    )
  })

  it('strips a Gmail "On … wrote:" block whose attribution wraps across lines', () => {
    // The real-world case: long reply+<id>@reply.winbackflow.co address wraps
    // the attribution onto a second line, so "On" and "wrote:" are separate.
    const raw = [
      'If you have a slack integration, I might reconsider',
      '',
      'On Wed, May 20, 2026 at 7:03 PM Thejas from Fitness App <',
      'reply+0a950a0b-1b5e-491c-bf57-c3f1b68292cf@reply.winbackflow.co> wrote:',
      '',
      '> Sorry to see you go, Marcus — mind sharing what led to it?',
      '> — Thejas',
    ].join('\n')
    expect(stripQuotedReply(raw)).toBe('If you have a slack integration, I might reconsider')
  })

  it('strips a single-line "On … wrote:" attribution', () => {
    const raw = 'Yeah cancel it.\n\nOn Mon, Jan 1, 2026 at 9:00 AM Alex wrote:\nplease confirm'
    expect(stripQuotedReply(raw)).toBe('Yeah cancel it.')
  })

  it('strips classic ">" quoted lines', () => {
    const raw = 'Too expensive for me.\n> Sorry to see you go\n> Resubscribe here'
    expect(stripQuotedReply(raw)).toBe('Too expensive for me.')
  })

  it('strips an Outlook "-----Original Message-----" block', () => {
    const raw = 'Switched to a competitor.\n\n-----Original Message-----\nFrom: Thejas\nSubject: Sorry to see you go'
    expect(stripQuotedReply(raw)).toBe('Switched to a competitor.')
  })

  it('strips an Outlook "From:/Sent:" header block', () => {
    const raw = "I'll think about it.\n\nFrom: Thejas <a@b.co>\nSent: Wednesday\nTo: me\nSubject: hi"
    expect(stripQuotedReply(raw)).toBe("I'll think about it.")
  })

  it('strips a mobile "Sent from my iPhone" sign-off', () => {
    const raw = 'Maybe later.\n\nSent from my iPhone'
    expect(stripQuotedReply(raw)).toBe('Maybe later.')
  })

  it('strips an RFC-3676 "-- " signature delimiter', () => {
    const raw = 'No thanks.\n\n-- \nMarcus Hale\nFounder, Acme'
    expect(stripQuotedReply(raw)).toBe('No thanks.')
  })

  it('cuts at the earliest of multiple markers', () => {
    const raw = 'Real reply.\n> quoted\n\nOn Mon Alex wrote:\nstuff'
    expect(stripQuotedReply(raw)).toBe('Real reply.')
  })

  it('does not over-trim a reply that merely contains the word "on"', () => {
    const raw = 'I turned it on and it worked, so I changed my mind.'
    expect(stripQuotedReply(raw)).toBe('I turned it on and it worked, so I changed my mind.')
  })

  it('collapses excess blank lines and trims', () => {
    const raw = '  Keeping it short.  \n\n\n\nThanks'
    expect(stripQuotedReply(raw)).toBe('Keeping it short.\n\nThanks')
  })
})
