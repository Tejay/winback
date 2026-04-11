import { describe, it, expect } from 'vitest'
import { stripQuotedLines } from '../lib/reply'

describe('stripQuotedLines', () => {
  it('removes lines starting with >', () => {
    const input = `Thanks for reaching out!

I left because the export feature was broken.

> On Jan 15, you wrote:
> Hi Sarah, I noticed you cancelled...
> Would you mind sharing what happened?`

    const result = stripQuotedLines(input)
    expect(result).toContain('Thanks for reaching out!')
    expect(result).toContain('export feature was broken')
    expect(result).not.toContain('On Jan 15')
    expect(result).not.toContain('Hi Sarah')
  })

  it('handles indented quoted lines', () => {
    const input = `Actual reply here
  > quoted line with leading spaces
> another quoted line`

    const result = stripQuotedLines(input)
    expect(result).toContain('Actual reply here')
    expect(result).not.toContain('quoted line')
    expect(result).not.toContain('another quoted')
  })

  it('returns empty string for all-quoted input', () => {
    const input = `> line 1
> line 2
> line 3`
    expect(stripQuotedLines(input)).toBe('')
  })

  it('preserves non-quoted content intact', () => {
    const input = 'Just a plain reply with no quotes'
    expect(stripQuotedLines(input)).toBe(input)
  })
})
