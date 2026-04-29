/**
 * Spec 37 — renderDunningEmailHtml: pure-rendering tests.
 *
 * No mocks needed — the helper takes plain inputs and returns a string.
 * Tests assert structural correctness of the markup (button anchor,
 * unsubscribe styling, T1 vs T3 copy, XSS escape) rather than full
 * snapshots — so cosmetic tweaks to padding/colors don't churn the tests.
 */
import { describe, it, expect } from 'vitest'
import { renderDunningEmailHtml, escapeHtml } from '../lib/email-html'

const baseInputs = {
  customerName: 'Eve',
  planName:     'Premium Monthly',
  amount:       '49.00',
  currency:     'usd',
  updateLink:   'https://app.example.com/api/update-payment/sub_1',
  unsubLink:    'https://app.example.com/api/unsubscribe/sub_1?t=tok',
  fromName:     'Thejas',
}

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml(`<script>alert("x")&'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;')
  })

  it('leaves plain text alone', () => {
    expect(escapeHtml('Fitness App')).toBe('Fitness App')
  })
})

describe('renderDunningEmailHtml (Spec 37)', () => {
  it('renders the update link as a clickable <a> with the exact href', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      retryDateStr: '2 May',
    })

    expect(html).toContain(`href="${baseInputs.updateLink}"`)
    expect(html).toContain('>Update payment</a>')
  })

  it('styles the button with the dark Winback action color (regression guard for tone)', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      retryDateStr: '2 May',
    })

    // CTA button background — table cell wrapping the <a>
    expect(html).toContain('background:#0f172a')
    // White text inside the anchor
    expect(html).toMatch(/color:#ffffff[^"]*">Update payment/)
  })

  it('renders the unsubscribe link in small grey (Spec 37 de-emphasis)', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      retryDateStr: '2 May',
    })

    expect(html).toContain(`href="${baseInputs.unsubLink}"`)
    // Footer text is small and grey
    expect(html).toContain('font-size:11px')
    expect(html).toContain('color:#94a3b8')
    expect(html).toContain('>Unsubscribe</a>')
  })

  it('escapes customer name to prevent XSS via the greeting', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      customerName: '<script>alert("x")</script>',
      retryDateStr: '2 May',
    })

    // The raw <script> never appears
    expect(html).not.toContain('<script>alert')
    // The escaped form does
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('falls back to "Hi there," when customerName is null', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      customerName: null,
      retryDateStr: '2 May',
    })

    expect(html).toContain('Hi there,')
  })

  it('T1/T2 (retry coming, not final) shows "try again on" copy + Heads up tone', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      retryDateStr: '2 May',
      isFinalRetry: false,
    })

    expect(html).toContain('Heads up')
    expect(html).toContain("We'll try your card again on")
    expect(html).toContain('<strong>2 May</strong>')
    expect(html).not.toContain('Final reminder')
    expect(html).not.toContain('last automatic attempt')
    expect(html).not.toContain('one final time')
  })

  it('T3 (final retry IS coming) shows "one final time" urgency + Final reminder tone', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      retryDateStr: '2 May',
      isFinalRetry: true,
    })

    expect(html).toContain('Final reminder')
    expect(html).toContain("We'll try your card one final time on")
    expect(html).toContain('<strong>2 May</strong>')
    expect(html).toContain('subscription will be cancelled')
    expect(html).not.toContain("We'll try your card again on")
    expect(html).not.toContain('Heads up')
    expect(html).not.toContain('last automatic attempt')
  })

  it('Stripe-gave-up path (retryDateStr null) shows "last automatic attempt" copy', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      retryDateStr: null,
      isFinalRetry: true,
    })

    expect(html).toContain('Final reminder')
    expect(html).toContain('last automatic attempt')
    expect(html).not.toContain("We'll try your card")
  })

  it('uppercases the currency in the body line', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      currency:     'gbp',
      retryDateStr: '2 May',
    })

    expect(html).toContain('49.00 GBP')
    expect(html).not.toContain('49.00 gbp')
  })

  it('escapes plan name to prevent injection via merchant-controlled text', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      planName:     'Plan <evil>',
      retryDateStr: '2 May',
    })

    expect(html).not.toContain('Plan <evil>')
    expect(html).toContain('Plan &lt;evil&gt;')
  })

  it('escapes from name (founder display name)', () => {
    const html = renderDunningEmailHtml({
      ...baseInputs,
      fromName:     'Tej & Co',
      retryDateStr: '2 May',
    })

    expect(html).toContain('— Tej &amp; Co')
    expect(html).not.toContain('— Tej & Co')
  })
})
