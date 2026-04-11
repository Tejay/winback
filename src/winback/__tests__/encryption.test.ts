import { describe, it, expect } from 'vitest'
import { encrypt, decrypt } from '../lib/encryption'

describe('encryption', () => {
  it('round-trips: encrypt then decrypt returns original', () => {
    const original = 'sk_test_abc123_secret_token'
    const ciphertext = encrypt(original)
    expect(decrypt(ciphertext)).toBe(original)
  })

  it('produces different ciphertext for same input (random IV)', () => {
    const input = 'same_plaintext_value'
    const a = encrypt(input)
    const b = encrypt(input)
    expect(a).not.toBe(b)
    // Both still decrypt correctly
    expect(decrypt(a)).toBe(input)
    expect(decrypt(b)).toBe(input)
  })

  it('throws on tampered ciphertext', () => {
    const ciphertext = encrypt('test_value')
    const buf = Buffer.from(ciphertext, 'base64')
    // Flip a byte in the encrypted portion
    buf[buf.length - 1] ^= 0xff
    const tampered = buf.toString('base64')
    expect(() => decrypt(tampered)).toThrow()
  })
})
