import { describe, it, expect } from 'vitest'
import { validateFirstMessage } from '../lib/classifier'
import { good, bad } from './fixtures/message-golden'

describe('validateFirstMessage — golden good samples', () => {
  for (const g of good) {
    it(`accepts: ${g.name}`, () => {
      const result = validateFirstMessage(g.body, g.tier, { hasChangelogMatch: g.hasChangelogMatch })
      expect(result.issues, result.issues.join(' | ')).toEqual([])
      expect(result.ok).toBe(true)
    })
  }
})

describe('validateFirstMessage — golden bad samples', () => {
  for (const b of bad) {
    it(`rejects: ${b.name}`, () => {
      const result = validateFirstMessage(b.body, b.tier, { hasChangelogMatch: b.hasChangelogMatch })
      expect(result.ok).toBe(false)
      const matched = result.issues.some(issue => b.expectIssue.test(issue))
      expect(matched, `expected an issue matching ${b.expectIssue} in [${result.issues.join(' | ')}]`).toBe(true)
    })
  }
})

describe('validateFirstMessage — tier 4', () => {
  it('skips validation for suppressed tier', () => {
    const result = validateFirstMessage('', 4)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('validateFirstMessage — individual rule spot checks', () => {
  it('flags a single exclamation mark', () => {
    const body = [
      'Hi Sam,',
      '',
      "I saw you left. Would you mind sharing what happened!",
      '',
      '— Jamie',
    ].join('\n')
    const result = validateFirstMessage(body, 2)
    expect(result.issues.some(i => i.includes('exclamation'))).toBe(true)
  })

  it('flags a 1-sentence body as too short', () => {
    const body = [
      'Hi Sam,',
      '',
      'Would you mind sharing what happened?',
      '',
      '— Jamie',
    ].join('\n')
    const result = validateFirstMessage(body, 2)
    expect(result.issues.some(i => i.includes('minimum is 2'))).toBe(true)
  })

  it('accepts a clean 2-sentence Tier 3 body with a trailing question', () => {
    const body = [
      'Hi Morgan,',
      '',
      'I noticed your subscription ended last week with no reason given. Would you mind sharing what happened?',
      '',
      '— Taylor',
    ].join('\n')
    const result = validateFirstMessage(body, 3)
    expect(result.issues).toEqual([])
  })

  it("flags 'reactivate' + '?' as a stacked path", () => {
    const body = [
      'Hi Morgan,',
      '',
      'I saw you cancelled. Would you like to reactivate your plan?',
      '',
      '— Taylor',
    ].join('\n')
    const result = validateFirstMessage(body, 1, { hasChangelogMatch: false })
    expect(result.issues.some(i => i.includes('stacks'))).toBe(true)
  })
})
