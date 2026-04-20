# Spec 24b — Phase 9.2b: Invoice display in Settings

**Phase:** Next up (April 2026)
**Depends on:** Spec 24a (invoice cron), Spec 23 (card capture)
**Unblocks:** Paid launch (customers can see where their money went)

---

## Summary

Surface billing history in `/settings`: list of past invoices with
amount, period, status, and links to view / download PDF (both served
by Stripe's hosted invoice infrastructure). Plus a **Manage billing**
button that opens the Stripe Customer Portal for the customer to update
payment method, view full history, and pay any failed invoices.

---

## Context

Today the Settings billing section shows "Invoices · None yet" as
hardcoded text (line ~188 of `app/settings/page.tsx`). After spec 24a
ships, real invoices exist in Stripe. We need to pull them and show
them.

**Not building**: custom-rendered invoice pages. Stripe already hosts
professional invoice PDFs and payment pages. We link to those.

---

## Design

### Data source

Fetched server-side on Settings page render. Matches the pattern from
spec 23 (payment method display). One Stripe API call per page load.

```ts
// src/winback/lib/platform-billing.ts (extended)
export interface InvoiceSummary {
  id: string
  number: string | null       // 'INV-0001'
  periodLabel: string         // 'May 2026' (derived from metadata or period_end)
  amountDueCents: number
  amountPaidCents: number
  currency: string
  status: string              // 'paid' | 'open' | 'uncollectible' | 'void' | 'draft'
  createdAt: Date
  hostedInvoiceUrl: string | null   // Stripe-hosted page
  invoicePdfUrl: string | null      // Direct PDF download
}

export async function fetchPlatformInvoices(
  platformCustomerId: string | null,
  limit = 12,
): Promise<InvoiceSummary[]> {
  if (!platformCustomerId) return []
  try {
    const stripe = getPlatformStripe()
    const list = await stripe.invoices.list({
      customer: platformCustomerId,
      limit,
      // no status filter — show all, let the UI render status
    })
    return list.data.map(inv => ({
      id: inv.id ?? '',
      number: inv.number,
      periodLabel: humanPeriodFromInvoice(inv),
      amountDueCents: inv.amount_due,
      amountPaidCents: inv.amount_paid,
      currency: inv.currency,
      status: inv.status ?? 'draft',
      createdAt: new Date(inv.created * 1000),
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdfUrl: inv.invoice_pdf,
    }))
  } catch (err) {
    console.warn('[platform-billing] Failed to list invoices:', err)
    return []
  }
}
```

`humanPeriodFromInvoice`: prefers `metadata.period_yyyymm` set by the
cron (e.g. `"2026-05"` → `"May 2026"`), falls back to the month of
`period_end` or `created`.

### Customer Portal session

New endpoint to create a billing portal session on demand.

```ts
// app/api/billing/portal-session/route.ts
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) return 401

  const [customer] = await db.select(...).where(eq(customers.userId, session.user.id)).limit(1)
  if (!customer?.stripePlatformCustomerId) return 404  // no customer yet = no portal

  const stripe = getPlatformStripe()
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'

  const portal = await stripe.billingPortal.sessions.create({
    customer: customer.stripePlatformCustomerId,
    return_url: `${baseUrl}/settings`,
  })

  logEvent({ name: 'billing_portal_opened', customerId: customer.id })

  return NextResponse.json({ url: portal.url })
}
```

Customer Portal has to be **configured once in the Stripe dashboard**
before this works (Settings → Billing → Customer Portal). Default
config is fine:
- ✅ Show invoice history
- ✅ Update payment method
- ❌ Cancel subscription (we don't use subscriptions)

### UI — invoice list in Settings

Replace the hardcoded "Invoices · None yet" block with a rendered list.

**Server component** (`app/settings/page.tsx`):

```tsx
const invoices = await fetchPlatformInvoices(
  customer?.stripePlatformCustomerId ?? null,
  12,
)
// pass to <InvoiceList invoices={invoices} />
```

**Client component** (`app/settings/invoice-list.tsx`):

```tsx
'use client'

export function InvoiceList({ invoices }: { invoices: InvoiceSummary[] }) {
  const [portalLoading, setPortalLoading] = useState(false)

  async function openPortal() {
    setPortalLoading(true)
    const res = await fetch('/api/billing/portal-session', { method: 'POST' })
    const { url } = await res.json()
    window.open(url, '_blank')  // new tab — portal is external
    setPortalLoading(false)
  }

  if (invoices.length === 0) {
    return <EmptyState onManageBilling={openPortal} loading={portalLoading} />
  }

  return (
    <div>
      <table>
        {invoices.map(inv => (
          <tr>
            <td>{inv.periodLabel}</td>
            <td>{formatMoney(inv.amountDueCents, inv.currency)}</td>
            <td><StatusBadge status={inv.status} /></td>
            <td>
              {inv.hostedInvoiceUrl && <a href={inv.hostedInvoiceUrl} target="_blank">View</a>}
              {inv.invoicePdfUrl && <a href={inv.invoicePdfUrl}>Download PDF</a>}
            </td>
          </tr>
        ))}
      </table>
      <button onClick={openPortal}>Manage billing →</button>
    </div>
  )
}
```

Status badge colors (match existing patterns):
- `paid` → green
- `open` → amber (unpaid, awaiting auto-retry)
- `uncollectible` / `void` → slate
- `draft` → slate (rare — shouldn't show for finalized invoices)

### Mobile

Invoice table layout needs to reflow on mobile. Either:
- Stack rows (each invoice is a card with inner flex layout)
- Simple horizontal scroll

Use the same pattern as the dashboard table: `overflow-x-auto` wrapper
with `hidden md:table-cell` on less-important columns. Keep Period +
Status + Amount + Actions visible on mobile.

---

## Files

### New
- `app/api/billing/portal-session/route.ts` — creates Stripe Customer Portal session
- `app/settings/invoice-list.tsx` — client component for the list
- `src/winback/__tests__/invoice-display.test.ts` — unit tests

### Modified
- `src/winback/lib/platform-billing.ts` — add `fetchPlatformInvoices()` + `humanPeriodFromInvoice()`
- `app/settings/page.tsx` — fetch invoices at render, replace hardcoded section

### Reused
- `getPlatformStripe()` from `src/winback/lib/platform-stripe.ts`
- `auth()` from `lib/auth.ts`
- `logEvent()` from `src/winback/lib/events.ts`

### Env vars
None new.

---

## Stripe dashboard — one-time setup

Before shipping, configure the Customer Portal in Stripe dashboard:

1. Settings → Billing → Customer Portal → **Activate**
2. Set branding (product name = "Winback", logo)
3. Features: enable "Invoice history" + "Payment methods" + "Billing address"
4. Disable "Subscription cancellation" (N/A)
5. Set default return URL to `https://winbackflow.co/settings`

---

## Verification

### Unit
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new `invoice-display.test.ts` covers:
  - `fetchPlatformInvoices` null customer → empty array
  - `fetchPlatformInvoices` Stripe error → empty array (swallowed)
  - `humanPeriodFromInvoice` prefers metadata.period_yyyymm
  - `humanPeriodFromInvoice` falls back to month of created
  - Money formatting

### Manual (after spec 24a ships)
- [ ] Trigger the billing cron → invoice created in Stripe
- [ ] `/settings` renders the invoice with correct period + amount + status
- [ ] Click `[View]` → opens `hosted_invoice_url` in new tab (Stripe's page)
- [ ] Click `[Download PDF]` → browser downloads the PDF
- [ ] Click `[Manage billing →]` → opens Customer Portal in new tab, shows invoice history + PM update
- [ ] Customer with no invoices → empty state + Manage billing button still works
- [ ] Customer with no platform customer yet → list is empty, Manage billing returns 404 gracefully

### Mobile
- [ ] At 375px: invoice list stacks/scrolls cleanly, buttons reachable
