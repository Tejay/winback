import { describe, it, expect, beforeEach } from 'vitest'
import { generateUnsubscribeToken, verifyUnsubscribeToken } from '../lib/unsubscribe-token'

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'test-secret-for-hmac-signing'
})

describe('unsubscribe token', () => {
  it('round-trips a valid token', () => {
    const id = 'sub_abc123'
    const token = generateUnsubscribeToken(id)
    expect(verifyUnsubscribeToken(id, token)).toBe(true)
  })

  it('rejects a tampered token', () => {
    const token = generateUnsubscribeToken('sub_abc123')
    expect(verifyUnsubscribeToken('sub_abc123', token + 'x')).toBe(false)
  })

  it('rejects a token for a different subscriber', () => {
    const token = generateUnsubscribeToken('sub_abc123')
    expect(verifyUnsubscribeToken('sub_other', token)).toBe(false)
  })

  it('rejects null / empty tokens', () => {
    expect(verifyUnsubscribeToken('sub_abc123', null)).toBe(false)
    expect(verifyUnsubscribeToken('sub_abc123', undefined)).toBe(false)
    expect(verifyUnsubscribeToken('sub_abc123', '')).toBe(false)
  })

  it('produces stable tokens for the same id + secret', () => {
    const a = generateUnsubscribeToken('sub_abc123')
    const b = generateUnsubscribeToken('sub_abc123')
    expect(a).toBe(b)
  })
})
