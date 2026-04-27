import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockResolveEmail = vi.hoisted(() => vi.fn())
vi.mock('../lib/email', () => ({
  resolveFounderNotificationEmail: mockResolveEmail,
}))

const mockSend = vi.hoisted(() => vi.fn())
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend }
  },
}))

import { sendPlatformPaymentFailedEmail } from '../lib/billing-notifications'

describe('sendPlatformPaymentFailedEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 're_test_key'
    process.env.NEXT_PUBLIC_APP_URL = 'https://winbackflow.co'
  })

  it('sends a heads-up email with the amount and a settings link', async () => {
    mockResolveEmail.mockResolvedValue('founder@example.com')
    mockSend.mockResolvedValue({ id: 'em_1' })

    await sendPlatformPaymentFailedEmail({
      customerId: 'cust_1',
      invoiceAmountCents: 9900,
      hostedInvoiceUrl: 'https://stripe.com/inv_x',
    })

    expect(mockSend).toHaveBeenCalledTimes(1)
    const args = mockSend.mock.calls[0][0]
    expect(args.to).toBe('founder@example.com')
    expect(args.subject).toContain('$99.00')
    expect(args.text).toContain('https://winbackflow.co/settings#billing')
    expect(args.text).toContain('https://stripe.com/inv_x')
  })

  it('skips silently when there is no notification email on file', async () => {
    mockResolveEmail.mockResolvedValue(null)

    await sendPlatformPaymentFailedEmail({
      customerId: 'cust_1',
      invoiceAmountCents: 9900,
      hostedInvoiceUrl: null,
    })

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('skips silently when RESEND_API_KEY is not set', async () => {
    delete process.env.RESEND_API_KEY
    mockResolveEmail.mockResolvedValue('founder@example.com')

    await sendPlatformPaymentFailedEmail({
      customerId: 'cust_1',
      invoiceAmountCents: 9900,
      hostedInvoiceUrl: null,
    })

    expect(mockSend).not.toHaveBeenCalled()
  })

  it('does not throw when Resend errors', async () => {
    mockResolveEmail.mockResolvedValue('founder@example.com')
    mockSend.mockRejectedValue(new Error('resend down'))

    await expect(
      sendPlatformPaymentFailedEmail({
        customerId: 'cust_1',
        invoiceAmountCents: 9900,
        hostedInvoiceUrl: null,
      }),
    ).resolves.toBeUndefined()
  })
})
