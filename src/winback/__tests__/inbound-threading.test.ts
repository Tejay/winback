import { describe, it, expect } from 'vitest'
import {
  extractEnvelope,
  parseSubscriberIdFromTo,
} from '@/app/api/email/inbound/route'

/**
 * Spec 63 sweep A — covers the inbound `to`-address parsing and the
 * Resend payload-shape extraction. These are the threading primitives:
 * every reply we receive must resolve to exactly one subscriber row, and
 * a malformed inbound must reject gracefully (200 with `processed:false`,
 * not 500).
 *
 * The full POST handler is not tested here — it pulls in Svix, the DB,
 * the classifier, and Resend, all of which already have dedicated
 * test files. This file tests *only* the parsing layer.
 */

describe('parseSubscriberIdFromTo', () => {
  it('extracts a lowercase UUID', () => {
    expect(
      parseSubscriberIdFromTo(
        'reply+550e8400-e29b-41d4-a716-446655440000@reply.winbackflow.co',
      ),
    ).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('extracts an uppercase UUID (regex is case-insensitive)', () => {
    expect(
      parseSubscriberIdFromTo(
        'reply+550E8400-E29B-41D4-A716-446655440000@reply.winbackflow.co',
      ),
    ).toBe('550E8400-E29B-41D4-A716-446655440000')
  })

  it('extracts the id regardless of host (custom domain still parses)', () => {
    expect(
      parseSubscriberIdFromTo(
        'reply+abc123-def@some-other-host.example.com',
      ),
    ).toBe('abc123-def')
  })

  it('extracts the id from a name-wrapped address', () => {
    // The route currently passes the bare `to` value into the parser, but
    // a name-wrapped form (`"Founder" <reply+id@host>`) must still resolve
    // — Resend has been observed to deliver both shapes depending on the
    // forwarding hop. The regex is anchored on `reply+...@`, not on the
    // start of string, so this should work.
    expect(
      parseSubscriberIdFromTo('"Founder" <reply+abc123@reply.winbackflow.co>'),
    ).toBe('abc123')
  })

  it('returns null when the to has no reply+ tag', () => {
    expect(
      parseSubscriberIdFromTo('hello@reply.winbackflow.co'),
    ).toBeNull()
  })

  it('returns null when the reply+ tag has no body before @', () => {
    expect(
      parseSubscriberIdFromTo('reply+@reply.winbackflow.co'),
    ).toBeNull()
  })

  it('returns null when there is no @ separator at all', () => {
    expect(parseSubscriberIdFromTo('reply+abc123')).toBeNull()
  })

  it('returns null on empty string', () => {
    expect(parseSubscriberIdFromTo('')).toBeNull()
  })

  it('rejects ids containing characters outside [a-f0-9-]', () => {
    // The regex is intentionally narrow: subscriber IDs are UUIDs, all hex
    // + dashes. A `+tag` like `reply+admin@host` must NOT resolve to a
    // subscriber, even if a row with id='admin' existed somehow.
    expect(
      parseSubscriberIdFromTo('reply+admin@reply.winbackflow.co'),
    ).toBeNull()
  })

  it('takes the first match when multiple reply+ fragments are present', () => {
    // Defensive: a forwarded thread might inline a second reply-to in the
    // bare-from address visible to the parser. We only care about the
    // first hit; the rest is the body's problem.
    expect(
      parseSubscriberIdFromTo(
        'reply+aaa@host.com, reply+bbb@other.com',
      ),
    ).toBe('aaa')
  })
})

describe('extractEnvelope — Resend payload shapes', () => {
  it('extracts from the standard data-wrapped envelope', () => {
    const body = {
      type: 'email.received',
      created_at: '2026-05-12T00:00:00Z',
      data: {
        email_id: 'em_123',
        to: 'reply+sub-1@reply.winbackflow.co',
        from: 'sarah@example.com',
      },
    }
    const out = extractEnvelope(body)
    expect(out).toEqual({
      emailId: 'em_123',
      to: 'reply+sub-1@reply.winbackflow.co',
      from: 'sarah@example.com',
      text: '',
    })
  })

  it('falls back to the unwrapped envelope (defensive against shape drift)', () => {
    const body = {
      email_id: 'em_456',
      to: 'reply+sub-2@reply.winbackflow.co',
      from: 'bob@example.com',
    }
    const out = extractEnvelope(body)
    expect(out.emailId).toBe('em_456')
    expect(out.to).toBe('reply+sub-2@reply.winbackflow.co')
    expect(out.from).toBe('bob@example.com')
  })

  it('handles `to` as a string', () => {
    const out = extractEnvelope({ data: { to: 'reply+abc@host.com' } })
    expect(out.to).toBe('reply+abc@host.com')
  })

  it('handles `to` as a string array (takes the first)', () => {
    const out = extractEnvelope({
      data: { to: ['reply+first@host.com', 'reply+second@host.com'] },
    })
    expect(out.to).toBe('reply+first@host.com')
  })

  it('handles `to` as an object with .email', () => {
    const out = extractEnvelope({
      data: { to: { email: 'reply+xyz@host.com' } },
    })
    expect(out.to).toBe('reply+xyz@host.com')
  })

  it('handles `to` as an array of objects with .email', () => {
    const out = extractEnvelope({
      data: { to: [{ email: 'reply+first@host.com' }, { email: 'reply+second@host.com' }] },
    })
    expect(out.to).toBe('reply+first@host.com')
  })

  it('handles `from` as an object with .email', () => {
    const out = extractEnvelope({
      data: { from: { email: 'sarah@example.com' } },
    })
    expect(out.from).toBe('sarah@example.com')
  })

  it('prefers data.text over data.plain_text when both present', () => {
    const out = extractEnvelope({
      data: { text: 'hello', plain_text: 'fallback' },
    })
    expect(out.text).toBe('hello')
  })

  it('falls back to plain_text when text is absent', () => {
    const out = extractEnvelope({ data: { plain_text: 'legacy field' } })
    expect(out.text).toBe('legacy field')
  })

  it('returns empty strings for missing fields without throwing', () => {
    const out = extractEnvelope({})
    expect(out).toEqual({ emailId: '', to: '', from: '', text: '' })
  })

  it('returns empty strings when data is an empty object', () => {
    const out = extractEnvelope({ data: {} })
    expect(out).toEqual({ emailId: '', to: '', from: '', text: '' })
  })

  it('survives a literal-null body without throwing', () => {
    // A JSON body of literal `null` parses to JS null. Previously this
    // crashed extractEnvelope with TypeError on `src.to`, returning 500
    // and tripping Resend's retry loop.
    const out = extractEnvelope(null)
    expect(out).toEqual({ emailId: '', to: '', from: '', text: '' })
  })

  it('survives an undefined body without throwing', () => {
    const out = extractEnvelope(undefined)
    expect(out).toEqual({ emailId: '', to: '', from: '', text: '' })
  })
})

describe('integration: parseSubscriberIdFromTo composed with extractEnvelope', () => {
  it('resolves a real Resend webhook payload end-to-end', () => {
    const body = {
      type: 'email.received',
      data: {
        email_id: 'em_real',
        to: ['reply+550e8400-e29b-41d4-a716-446655440000@reply.winbackflow.co'],
        from: 'sarah@example.com',
      },
    }
    const env = extractEnvelope(body)
    const subscriberId = parseSubscriberIdFromTo(env.to)
    expect(subscriberId).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('a Resend payload addressed to a non-reply mailbox yields null subscriber', () => {
    const body = {
      type: 'email.received',
      data: { email_id: 'em_other', to: 'support@winbackflow.co' },
    }
    const env = extractEnvelope(body)
    expect(parseSubscriberIdFromTo(env.to)).toBeNull()
  })
})
