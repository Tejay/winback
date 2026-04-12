# Spec 04 — Core Engine (Stripe, Classifier, Email, Reply)

**Phase:** 4
**Depends on:** Spec 01 (database + types), Spec 03 (OAuth tokens are being saved)
**Estimated time:** 5 hours
**Human checkpoints:** 4

---

## Part A — src/winback/lib/encryption.ts

AES-256-GCM encryption using Node.js built-in `crypto`. No external dependencies.

`ENCRYPTION_KEY` must be exactly 32 hex characters (16 bytes) from env vars.
Validate key length on module load — throw immediately if wrong.

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const KEY = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex')
if (KEY.length !== 16) throw new Error('ENCRYPTION_KEY must be exactly 32 hex chars (16 bytes)')

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-128-gcm', KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64')
  const iv  = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = createDecipheriv('aes-128-gcm', KEY, iv)
  decipher.setAuthTag(tag)
  return decipher.update(enc) + decipher.final('utf8')
}
```

**Tests** (`src/winback/__tests__/encryption.test.ts`):
1. `encrypt(x)` → `decrypt(result)` === `x`
2. Same input → different ciphertext each call (random IV)
3. Wrong key → throws — does not return wrong plaintext

---

## Part B — src/winback/lib/stripe.ts

```typescript
import Stripe from 'stripe'
import { SubscriberSignals } from './types'

// Uses the CUSTOMER's OAuth access token — not our platform key
export async function extractSignals(
  subscription: Stripe.Subscription,
  accessToken: string
): Promise<SubscriberSignals>
```

Implementation:
1. Create Stripe client with `accessToken` (pass as `apiKey` constructor arg)
2. Fetch `customer` object → get `email` and `name`
3. `tenureDays` = `Math.floor((cancelledAt - startDate) / 86400000)`
4. `nearRenewal` = `cancelledAt` within 3 days of `current_period_end`
5. Fetch all invoices (`limit: 100`):
   - `everUpgraded` = true if more than one distinct price ID found across line items
   - `paymentFailures` = count of invoices where `attempt_count > 1` OR `status === 'uncollectible'`
6. Fetch all subscriptions (`status: 'all'`, `limit: 100`) → `previousSubs = totalCount - 1`
7. `stripeEnum` = `subscription.cancellation_details?.feedback ?? null`
8. `stripeComment` = `subscription.cancellation_details?.comment ?? null`
9. Return `SubscriberSignals` object

---

## Part C — app/api/stripe/webhook/route.ts

```typescript
// CRITICAL: Must use raw body — do NOT call req.json()
export const runtime = 'nodejs'

export async function POST(req: Request) {
  const rawBody = Buffer.from(await req.arrayBuffer())
  const sig     = req.headers.get('stripe-signature') ?? ''

  // Single Connect webhook on platform account — one STRIPE_WEBHOOK_SECRET for all connected accounts
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err) {
    console.error('Webhook signature failed:', err)
    return new Response('Invalid signature', { status: 400 })
  }

  // Process synchronously — do NOT fire-and-forget on serverless (function dies after response)
  if (event.type === 'customer.subscription.deleted') {
    await processChurn(event)
  }
  if (event.type === 'customer.subscription.created') {
    await processRecovery(event)
  }

  return new Response('ok', { status: 200 })
}
```

**`processChurn(event)`:**
1. Find `wb_customers` where `stripe_account_id = event.account`
2. If not found → `console.log('Unknown Stripe account:', event.account)` and return
3. Query `wb_churned_subscribers` for existing `(customer_id, stripe_customer_id)` pair — **idempotency check**
4. If exists → `console.log('Duplicate webhook, skipping')` and return
5. Decrypt `customer.stripeAccessToken`
6. `extractSignals(subscription, decryptedToken)`
7. `classifySubscriber(signals, { founderName, productName, changelog })`
8. Insert row into `wb_churned_subscribers`
9. If `!classification.suppress` → `scheduleExitEmail({ subscriberId, email, classification, decryptedRefreshToken })`

**`processRecovery(event)`:**
1. Find `wb_customers` by `event.account`
2. Find `wb_churned_subscribers` by `email` for this customer where `status IN ('pending', 'contacted')`
3. If found:
   - Create `wb_recoveries` record with `attribution_ends_at = NOW() + 365 days`
   - Update subscriber `status = 'recovered'`
   - `console.log('RECOVERY:', email, 'at', mrr)`

**Test fixtures** (`src/winback/__tests__/fixtures/`):
- `subscription_deleted_basic.json` — no `cancellation_details`
- `subscription_deleted_with_enum.json` — `feedback: 'too_expensive'`
- `subscription_deleted_with_comment.json` — `comment: "I needed a Zapier integration"`
- `subscription_created.json` — new subscription (resubscribe)

**Tests** (`src/winback/__tests__/webhook.test.ts`) — 6 cases:
1. Invalid signature → 400 response
2. Unknown event type (`payment_intent.created`) → 200, no DB write
3. Unknown Stripe account → 200, no DB write, log message
4. Valid `subscription.deleted` → row created in `wb_churned_subscribers`
5. Duplicate webhook (same event) → still 200, NO second row created
6. `subscription.created` for known churned email → row created in `wb_recoveries`

⛔ **CHECKPOINT — after tests pass:**
```
Run in a separate terminal:
  stripe login
  stripe listen --forward-to localhost:3000/api/stripe/webhook

Copy the webhook signing secret (whsec_...) to .env.local as STRIPE_WEBHOOK_SECRET.
Tell me when the CLI is listening.
```
Then run: `stripe trigger customer.subscription.deleted`
Confirm a row appears in `wb_churned_subscribers`.

---

## Part D — src/winback/lib/classifier.ts

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { SubscriberSignals, ClassificationResult } from './types'

// IMPORTANT: Use lazy initialization — process.env.ANTHROPIC_API_KEY may be
// empty at module load time (Claude Code overrides it with empty string).
// Read from .env.local as fallback if env var is empty.
function getClient() {
  return new Anthropic({ apiKey: getApiKey() })
}

export async function classifySubscriber(
  signals: SubscriberSignals,
  context: { productName?: string; founderName?: string; changelog?: string }
): Promise<ClassificationResult>
```

**Model:** `claude-haiku-4-5-20251001`
**max_tokens:** 1500
**temperature:** 0

**System prompt:**
```
You are a win-back classification engine for subscription businesses.
Analyse a cancelled subscriber's signals and return a JSON decision.

TIER DEFINITIONS:
1 — Explicit stated reason in stripe_comment or reply_text. Send targeted message.
2 — Stripe enum only (e.g. too_expensive), no free text. Send directional message asking for more detail.
3 — Billing signals only. Generic honest re-engagement. NEVER claim to know why they left.
4 — Suppress. No email. Use when: email is null, tenure < 5 days, obvious test/spam account.

RULES:
- Never invent a reason that isn't in the signal data
- Tier 3 messages must never reference a specific exit reason
- Never say "we noticed you cancelled" — always say "we noticed you're no longer subscribed." 
  This is important: some subscribers leave via payment blocking, not the cancellation flow.
- Never offer a discount unless price was explicitly mentioned by the subscriber
- cancellationReason: short phrase shown in a dashboard table (e.g. "Switched to a competitor")
- cancellationCategory: exactly one of: Competitor|Price|Quality|Unused|Feature|Other
- For Tier 2 and Tier 3, always end firstMessage.body with a single genuine question asking why they left. Keep it to one sentence. Frame it as curiosity, not a survey. Good example: "Would you mind sharing what happened? Hit reply — one line is enough." Bad example: "Please complete our exit survey." Do NOT add this question to Tier 1 — they already told you why they left.
- Return ONLY valid JSON with no preamble and no markdown code fences
```

**User prompt:** Build from all signal fields. Mark absent ones as `"not_provided"`.

**Zod schema** (validate LLM output before returning):
```typescript
const ClassificationSchema = z.object({
  tier:                 z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  tierReason:           z.string(),
  cancellationReason:   z.string(),
  cancellationCategory: z.enum(['Competitor','Price','Quality','Unused','Feature','Other']),
  confidence:           z.number().min(0).max(1),
  suppress:             z.boolean(),
  suppressReason:       z.string().optional(),
  firstMessage:         z.object({
    subject:       z.string(),
    body:          z.string(),
    sendDelaySecs: z.number(),
  }),
  triggerKeyword: z.string().nullable(),
  fallbackDays:   z.union([z.literal(30), z.literal(90), z.literal(180)]),
  winBackSubject: z.string(),
  winBackBody:    z.string(),
})
```

**Error handling — do not swallow errors:**
- API failure → throw with original error
- JSON.parse failure → `console.error('Raw LLM output:', raw)`, then throw
- Zod failure → `console.error('Failed LLM object:', parsed)`, then throw

**Tests** (mocked Anthropic client):

Scenario A — Tier 1, feature complaint:
  `stripeComment: "I needed a Zapier integration to connect to my CRM"`
  Expected: `tier===1`, `confidence≥0.85`, `triggerKeyword` contains `'zapier'`

Scenario B — Tier 1, email reply:
  `replyText: "The CSV export was too limited"`
  Expected: `tier===1`, `confidence≥0.90`, `triggerKeyword` contains `'csv'` or `'export'`

Scenario C — Tier 2, enum only:
  `stripeEnum: 'too_expensive'`, no comment, no reply
  Expected: `tier===2`, `0.50≤confidence≤0.75`, `cancellationCategory==='Price'`

Scenario D — Tier 3, long tenure, silent:
  `tenureDays: 280`, `everUpgraded: true`, no reason of any kind
  Expected: `tier===3`, `confidence≤0.70`, `firstMessage.body` does NOT mention a specific exit reason

Scenario E — Tier 4, suppress:
  `email: null`, `tenureDays: 2`
  Expected: `suppress===true`, `tier===4`

⛔ **CHECKPOINT — when all 5 mocked tests pass:**
"All 5 tests pass. One live Anthropic call costs ~$0.003. Type 'yes' to run a live test."
Run Scenario A live. Show the actual JSON output. Confirm it passes Zod.

---

## Part E — src/winback/lib/email.ts

```typescript
export async function sendEmail(params: {
  subscriberId: string
  to:           string
  subject:      string
  body:         string
  founderName:  string
}): Promise<{ messageId: string }>

export async function scheduleExitEmail(params: {
  subscriberId: string
  email:        string
  classification: ClassificationResult
  founderName:  string
}): Promise<void>
```

**`sendEmail` implementation:**
- Use Resend SDK (`new Resend(process.env.RESEND_API_KEY)`)
- From address: `"${founderName} via Winback <reply+${subscriberId}@winbackflow.co>"`
- Plain text only (no HTML)
- Return `messageId` from Resend response

**`scheduleExitEmail` implementation:**
- Send immediately (no setTimeout — Resend handles delivery)
- Call `sendEmail` with `firstMessage.subject` and `firstMessage.body`
- Insert row into `wb_emails_sent` (`type: 'exit'`)
- Update `wb_churned_subscribers.status = 'contacted'`

**Tests** (mocked Resend):
1. Correct from address format with subscriberId
2. Plain text body sent correctly
3. `scheduleExitEmail` calls `sendEmail` and inserts DB rows
4. After send: row exists in `wb_emails_sent`, subscriber status is `'contacted'`

---

## Part F — src/winback/lib/reply.ts + inbound webhook

```typescript
// Process an inbound email reply from Resend webhook
export async function processReply(
  subscriberId: string,
  replyText:    string
): Promise<void>
```

**`app/api/email/inbound/route.ts`:**
Receives POST requests from Resend inbound webhook when a reply arrives.

```typescript
export async function POST(req: Request) {
  const body = await req.json()
  // Extract subscriberId from the "to" address: reply+{subscriberId}@winbackflow.co
  const toAddress = body.to
  const match = toAddress.match(/reply\+([a-f0-9-]+)@/)
  if (!match) return new Response('Unknown recipient', { status: 200 })
  const subscriberId = match[1]
  const replyText = body.text || body.html || ''
  await processReply(subscriberId, replyText)
  return new Response('ok', { status: 200 })
}
```

**`processReply`:**
1. Find `wb_emails_sent` for this subscriber where `replied_at IS NULL`
2. Update `wb_emails_sent.replied_at = NOW()`
3. Update `wb_churned_subscribers.reply_text = replyText`
4. Re-classify using `classifySubscriber` with `replyText` injected as primary signal
5. Update subscriber: `tier`, `confidence`, `triggerKeyword`, `winBackBody`, `winBackSubject`

**Tests:**
1. Inbound webhook with valid reply+{id} address → reply processed, `replied_at` set, tier updated
2. Inbound webhook with unknown address → 200, no DB changes
3. Re-classification updates subscriber fields correctly
4. Quoted content stripped correctly from reply body

---

## Definition of done
- [ ] `encryption.ts` — tests passing
- [ ] `stripe.ts` — `extractSignals` returns correct values for all fixtures
- [ ] Webhook handler — signature verification works
- [ ] `processChurn` is idempotent (duplicate webhook = no second row)
- [ ] `processRecovery` creates `wb_recoveries` row
- [ ] All 6 webhook tests passing
- [ ] Live Stripe CLI test confirmed
- [ ] `classifier.ts` — Zod schema defined
- [ ] All 5 mocked classifier tests passing
- [ ] Human approved + live classifier test passes Zod
- [ ] `email.ts` — all tests passing with mocked Resend
- [ ] `reply.ts` — all tests passing
- [ ] Inbound webhook endpoint created at `/api/email/inbound`
