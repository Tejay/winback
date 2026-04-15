import { describe, it, expect } from 'vitest'
import { slugifyWorkspaceName, confirmationMatches } from '../lib/workspace'

describe('slugifyWorkspaceName', () => {
  it('uses productName when present', () => {
    expect(slugifyWorkspaceName('Acme Corp', 'a@b.com')).toBe('acme-corp')
  })
  it('falls back to email when productName is missing', () => {
    expect(slugifyWorkspaceName(null, 'alex@yourcompany.com')).toBe('alex-yourcompany-com')
  })
  it('strips leading/trailing separators', () => {
    expect(slugifyWorkspaceName('  !!Wild/Product!!  ', 'x')).toBe('wild-product')
  })
  it('falls back to the fallback when productName is whitespace', () => {
    expect(slugifyWorkspaceName('   ', 'fallback-value')).toBe('fallback-value')
  })
})

describe('confirmationMatches', () => {
  it('accepts exact match', () => {
    expect(confirmationMatches('acme-corp', 'acme-corp')).toBe(true)
  })
  it('is case-insensitive', () => {
    expect(confirmationMatches('Acme-Corp', 'acme-corp')).toBe(true)
  })
  it('trims whitespace from user input', () => {
    expect(confirmationMatches('  acme-corp  ', 'acme-corp')).toBe(true)
  })
  it('rejects mismatch', () => {
    expect(confirmationMatches('acme', 'acme-corp')).toBe(false)
  })
})
