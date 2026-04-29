/**
 * Spec 36 — /welcome-back must render the merchant's brand (product
 * name) when a valid `customer` UUID is passed. Crucially, it must
 * NEVER render the Winback `<Logo />` — end customers of any merchant
 * should not see the third-party recovery system.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString } from 'react-dom/server'
import React from 'react'

const mockDbSelect = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockDbSelect },
}))

vi.mock('@/lib/schema', () => ({
  customers: {
    id:           'customers.id',
    productName:  'customers.productName',
    founderName:  'customers.founderName',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
}))

import WelcomeBackPage from '../../../app/welcome-back/page'

const VALID_UUID  = '38a705a6-3290-44e9-9971-193a7973d940'
const ANOTHER_UUID = '00000000-0000-0000-0000-000000000001'

function selectReturning(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

async function render(searchParams: Record<string, string | undefined>): Promise<string> {
  const element = await WelcomeBackPage({
    searchParams: Promise.resolve(searchParams),
  })
  return renderToString(element as React.ReactElement)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /welcome-back (Spec 36)', () => {
  it('renders the merchant productName when a valid customer UUID resolves to a row', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([{
      productName: 'Fitness App',
      founderName: 'Tej',
    }]))

    const html = await render({ recovered: 'true', customer: VALID_UUID })

    expect(html).toContain('Fitness App')
    expect(html).toContain('Welcome back!')
    expect(html).toContain('🎉')
  })

  it('falls back to founderName when productName is null', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([{
      productName: null,
      founderName: 'Acme Co',
    }]))

    const html = await render({ recovered: 'true', customer: VALID_UUID })

    expect(html).toContain('Acme Co')
  })

  it('renders no merchant identity when customer param is missing', async () => {
    const html = await render({ recovered: 'true' })

    // No DB call when no customer param
    expect(mockDbSelect).not.toHaveBeenCalled()
    // Generic copy still appears
    expect(html).toContain('Welcome back!')
  })

  it('renders no merchant identity when customer UUID is malformed (skips DB to avoid Postgres cast 500)', async () => {
    const html = await render({ recovered: 'true', customer: 'not-a-uuid' })

    expect(mockDbSelect).not.toHaveBeenCalled()
    expect(html).toContain('Welcome back!')
  })

  it('renders no merchant identity when customer UUID resolves to no row', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([]))

    const html = await render({ recovered: 'true', customer: ANOTHER_UUID })

    // Body still renders generic copy
    expect(html).toContain('Welcome back!')
  })

  it('renders no merchant identity when both productName and founderName are null', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([{
      productName: null,
      founderName: null,
    }]))

    const html = await render({ recovered: 'true', customer: VALID_UUID })

    expect(html).toContain('Welcome back!')
  })

  it('truncates names longer than 40 chars with an ellipsis', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([{
      productName: 'A'.repeat(60),
      founderName: null,
    }]))

    const html = await render({ recovered: 'true', customer: VALID_UUID })

    // 39 As + "…" — slice(0,39).trimEnd() + '…' = 40 chars total
    expect(html).toContain('A'.repeat(39) + '…')
    expect(html).not.toContain('A'.repeat(60))
  })

  it('NEVER renders the Winback Logo SVG (regression guard for all branches)', async () => {
    // Branch 1 — happy path
    mockDbSelect.mockReturnValueOnce(selectReturning([{ productName: 'X', founderName: null }]))
    let html = await render({ recovered: 'true', customer: VALID_UUID })
    // The Winback logo is the only blue rounded-xl with a lightning-bolt path
    // — assert neither marker is present.
    expect(html).not.toContain('rounded-xl bg-blue')
    expect(html).not.toMatch(/winback/i)

    // Branch 2 — direct nav
    mockDbSelect.mockReset()
    html = await render({ recovered: 'true' })
    expect(html).not.toContain('rounded-xl bg-blue')
    expect(html).not.toMatch(/winback/i)

    // Branch 3 — failure reason
    mockDbSelect.mockReset()
    html = await render({ recovered: 'false', reason: 'subscriber_not_found' })
    expect(html).not.toContain('rounded-xl bg-blue')
    expect(html).not.toMatch(/winback/i)
  })

  it('renders the merchant name on FAILURE pages too — not just success', async () => {
    mockDbSelect.mockReturnValueOnce(selectReturning([{
      productName: 'Pilates Studio',
      founderName: null,
    }]))

    const html = await render({
      recovered: 'false',
      reason:    'price_unavailable',
      customer:  VALID_UUID,
    })

    expect(html).toContain('Pilates Studio')
    // Failure copy (apostrophes get HTML-entity-encoded by react-dom/server)
    expect(html).toContain('We&#x27;ve updated our plans')
  })
})
