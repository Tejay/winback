# Winback regression — manual end-to-end checklist (Spec 63 sweep F)

**When to run:** before any prod release that touches the win-back AI
(classifier prompt, reply handling, handoff rules, changelog match, email
copy, gate stack).

**Time budget:** ~30 minutes once set up.

**Test environment:**
- Local app at `http://localhost:3000` (or ngrok URL — `tejay.ngrok.app`)
- Founder account: `tejaasvi@gmail.com` (per CLAUDE.md dev testing canonical)
- Stripe sandbox: `tkedambadi@gmail.com`
- Real Gmail to receive subscriber-facing emails
- `scripts/billing-test-reset.ts` already run to reset state

**Cost:** ~\$0.05 LLM (real classifier + judge calls during the run).

---

## Pre-flight (5 min)

- [ ] `git pull origin main` — make sure dev is on latest
- [ ] `npm run dev` — server up at localhost:3000
- [ ] ngrok tunnel up (`ngrok http --url=tejay.ngrok.app 3000`) if testing inbound
- [ ] `scripts/billing-test-reset.ts` run if state needs reset
- [ ] Confirm dev `.env.local` has `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
      `RESEND_WEBHOOK_SECRET`, and Stripe sandbox keys

---

## Subscriber-facing walk-throughs

For each scenario below: trigger the action via Stripe sandbox, wait for
the email in real Gmail, **read the actual email** (not just check it
arrived), and tick the rows.

### 1. Tier 1 — explicit price reason

- [ ] In Stripe sandbox, cancel a subscriber with comment
      `$49/mo is too much right now`
- [ ] Email arrives in Gmail within 60s
- [ ] Subject is 3–6 words, no exclamation marks
- [ ] Body opens with a validation phrase (`Fair call`, `That makes sense`,
      `You're right`, `I hear you`, `I get it`, `Fair enough`)
- [ ] Body references price specifically (not just "your concerns")
- [ ] Body is ≤120 words
- [ ] Plain text (no HTML, no rendered markdown)
- [ ] Reply with `Would 50% off bring me back?` — verify NO auto-reply
      arrives within 5 min (handoff path) and founder gets a handoff
      notification at `tejaasvi@gmail.com`
- [ ] In `/admin/handoffs` (or equivalent), the subscriber appears with
      the reply text and a handoff reasoning string

### 2. Tier 1 — explicit feature reason + changelog re-engagement

- [ ] Cancel a sandbox subscriber with comment
      `No SSO support, can't roll out to the team`
- [ ] Exit email arrives, references SSO concretely
- [ ] Reply `Still need it.` — verify auto-reply arrives within 60s and
      `triggerNeed` in DB contains "SSO"
- [ ] Update merchant changelog at `/settings` to include
      `Shipped SAML SSO this week.`
- [ ] Manually trigger reengagement cron at
      `curl http://localhost:3000/api/cron/reengagement -H "Authorization: Bearer $CRON_SECRET"`
- [ ] Re-engagement email arrives within 1 min; references SSO concretely;
      not a generic "we made improvements"

### 3. Tier 3 — silent churn

- [ ] Cancel a sandbox subscriber with NO comment and reason `other`
- [ ] Email arrives; opens softly (`Thanks for the N months`, no validation phrase)
- [ ] Body asks ONE genuine question (not a pointer + question stacked)
- [ ] Body does NOT claim to know why they left

### 4. Tier 4 — suppress (email is null)

- [ ] In `/admin`, manually null out a subscriber's email
- [ ] Trigger classification for that subscriber
- [ ] Verify NO email goes out
- [ ] Verify a `wb_events` row exists logging the suppress

### 5. DNC — subscriber unsubscribes

- [ ] In Gmail, click the unsubscribe `mailto:` link in any received email
- [ ] In `/admin/subscribers/[id]`, confirm `doNotContact=true`
- [ ] Trigger changelog match again (re-run reengagement cron) — verify
      NO email goes to this subscriber

### 6. Threading

- [ ] Reply to a Winback email from a Gmail alias (`tejay+test@gmail.com`)
- [ ] In `/admin/subscribers/[id]`, the reply appears in the conversation
      view linked to the correct subscriber row — not a new one

### 7. Inbound dedup (Spec 64)

- [ ] Capture the raw inbound webhook payload from Resend logs
- [ ] `curl -X POST $WEBHOOK_URL` with the same payload twice
- [ ] Second response is `{ processed: false, reason: 'already_processed' }`
- [ ] `wb_inbound_events` has exactly one row for the `email_id`
- [ ] No second auto-reply went to the subscriber

---

## Merchant-facing walk-throughs

Open `/admin` and `/dashboard` in a browser. For each item:

### 8. Status badges

- [ ] Recovered subscriber shows the green ✓ Recovered badge
- [ ] Contacted subscriber shows the blue ✉ Contacted badge
- [ ] Pending subscriber shows the amber ○ Pending badge
- [ ] Lost (no email sent / DNC) shows the gray × Lost badge

### 9. Handoff list

- [ ] `/admin/handoffs` (or wherever it lives) shows the price-negotiation
      handoff from scenario 1
- [ ] Reply text is visible
- [ ] Handoff reasoning is visible and reads like the classifier's actual
      judgment (not a templated string)

### 10. AI-pause toggle

- [ ] In `/admin/subscribers/[id]`, toggle AI-pause ON
- [ ] Trigger a follow-up classification — confirm NO email goes out
- [ ] Toggle AI-pause OFF — confirm subsequent flow resumes

### 11. Customer-level win-back pause

- [ ] In `/settings`, enable the win-back cohort pause
- [ ] Cancel a new sandbox subscriber — confirm NO win-back email
- [ ] Confirm payment-recovery emails still fire if you trigger a failed
      payment on a separate subscriber (Spec 55 independence)
- [ ] Disable the pause — confirm normal flow resumes

### 12. Per-event observability

- [ ] `/admin/events` lists each send + each gate-skip from the run
- [ ] Each `send_skipped_billing_pause` includes the right `subscriberId`
- [ ] Each `founder_handoff_triggered` includes a non-empty
      `recoveryLikelihood`

---

## Post-run

- [ ] All boxes ticked, OR each unticked box has a tracked issue
- [ ] Tag the release as ready for prod
- [ ] Note the cost of the run (rough \$ from Anthropic console)

If anything fails:
1. Don't ship.
2. Identify which sweep would have caught it (B/C/D/E) — if a gap, add a
   fixture for it in a follow-up PR.
3. Fix the underlying issue, re-run the affected section of this checklist.
