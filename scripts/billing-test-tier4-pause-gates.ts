// Tier 4 — Spec 55 split-pause gates.
//
// Verifies the two independent pause toggles work correctly:
//   - customers.paused_at         → blocks win-back emails (exit, reply)
//   - customers.paused_dunning_at → blocks dunning emails (T1, followup)
//   - Independent: toggling one does NOT affect the other
//   - Clearable: removing a flag resumes the corresponding email path
//
// Tactic for verification:
//   - Helper-level: isCustomerPausedForWinback / isCustomerPausedForDunning
//     return the right boolean for every combination of flag states.
//   - Integration-level (negative only): set the relevant pause flag,
//     call the actual email function, verify NO wb_emails_sent row is
//     created — proves the gate is wired inside the function, not just
//     in the helper.
//
// We don't trigger positive (should-send) integration cases because those
// would consume Resend API quota. The helper-level boolean check covers
// what we'd verify there.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier4-pause-gates.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, emailsSent, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import {
  isCustomerPausedForWinback,
  isCustomerPausedForDunning,
  scheduleExitEmail,
  sendDunningEmail,
} from '../src/winback/lib/email'

const TARGET_EMAIL = 'tejaasvi@gmail.com'

type Combo = { paused_at: Date | null; paused_dunning_at: Date | null }

async function setPauseFlags(customerId: string, combo: Combo) {
  await db.update(customers)
    .set({ pausedAt: combo.paused_at, pausedDunningAt: combo.paused_dunning_at, updatedAt: new Date() })
    .where(eq(customers.id, customerId))
}

async function seedSubscriber(customerId: string, kind: 'winback' | 'dunning'): Promise<string> {
  const tag = `tier4-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const [row] = await db.insert(churnedSubscribers).values({
    customerId,
    stripeCustomerId: `cus_TIER4_${tag}`,
    name: `Tier 4 ${kind} sub`,
    email: `${tag}@example.com`,
    cancellationReason: kind === 'winback' ? 'Lost interest' : 'Payment failed',
    dunningState: kind === 'dunning' ? 'awaiting_retry' : null,
    mrrCents: 5000,
    status: kind === 'dunning' ? 'lost' : 'lost',
  }).returning({ id: churnedSubscribers.id })
  return row.id
}

async function emailsSentCount(subscriberId: string): Promise<number> {
  const rows = await db.select().from(emailsSent).where(eq(emailsSent.subscriberId, subscriberId))
  return rows.length
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }

  console.log('=== Tier 4 — Spec 55 split-pause gates ===\n')

  // Some failure paths leave activatedAt or stripeSubscriptionId set; ignore
  // — we only care about pause flags here. Force them off for cleanliness so
  // isCustomerPausedForBilling (Spec 51 separate gate) doesn't also fire.
  await db.update(customers)
    .set({ activatedAt: null, stripeSubscriptionId: null, stripeSubscriptionCreatingAt: null })
    .where(eq(customers.id, c.id))

  // === Tier 4.helper — verify gate functions return correct booleans for all combos ===
  console.log('[helper-level] all 4 (paused_at × paused_dunning_at) combinations')
  const sub = await seedSubscriber(c.id, 'winback')
  const cases: Array<{ combo: Combo; expectWb: boolean; expectDn: boolean }> = [
    { combo: { paused_at: null,    paused_dunning_at: null    }, expectWb: false, expectDn: false },
    { combo: { paused_at: new Date(), paused_dunning_at: null }, expectWb: true,  expectDn: false },
    { combo: { paused_at: null,    paused_dunning_at: new Date() }, expectWb: false, expectDn: true },
    { combo: { paused_at: new Date(), paused_dunning_at: new Date() }, expectWb: true,  expectDn: true },
  ]
  let allPass = true
  for (const { combo, expectWb, expectDn } of cases) {
    await setPauseFlags(c.id, combo)
    const wb = await isCustomerPausedForWinback(sub)
    const dn = await isCustomerPausedForDunning(sub)
    const label = `paused_at=${combo.paused_at ? 'SET' : 'NULL'} paused_dunning_at=${combo.paused_dunning_at ? 'SET' : 'NULL'}`
    const okWb = wb === expectWb
    const okDn = dn === expectDn
    console.log(`  ${label}  →  isPausedForWinback=${wb}${okWb ? '✓' : '❌(expected ' + expectWb + ')'}  isPausedForDunning=${dn}${okDn ? '✓' : '❌(expected ' + expectDn + ')'}`)
    if (!okWb || !okDn) allPass = false
  }
  if (!allPass) { console.error('\n❌ helper-level boolean check failed'); process.exit(1) }
  console.log('  all 4 combinations OK\n')

  // === Tier 4.1 — paused_at set: scheduleExitEmail must NOT create a wb_emails_sent row ===
  console.log('[4.1] paused_at SET → scheduleExitEmail should skip (no wb_emails_sent row)')
  await setPauseFlags(c.id, { paused_at: new Date(), paused_dunning_at: null })
  const sub41 = await seedSubscriber(c.id, 'winback')
  await scheduleExitEmail({
    subscriberId: sub41,
    email: `tier4-1-${Date.now()}@example.com`,
    classification: {
      firstMessage: { subject: 'hi', body: 'hi' }, // non-empty so it doesn't early-return at firstMessage check
      handoff: null,
      pause: null,
      suppress: null,
    } as Parameters<typeof scheduleExitEmail>[0]['classification'],
    fromName: 'Tier 4 Tester',
  })
  const count41 = await emailsSentCount(sub41)
  console.log(`  emailsSentCount(sub41)=${count41}  ${count41 === 0 ? '✓' : '❌ (expected 0)'}`)

  // === Tier 4.2 — paused_dunning_at set: sendDunningEmail must NOT create a wb_emails_sent row ===
  console.log('\n[4.2] paused_dunning_at SET → sendDunningEmail should skip (no wb_emails_sent row)')
  await setPauseFlags(c.id, { paused_at: null, paused_dunning_at: new Date() })
  const sub42 = await seedSubscriber(c.id, 'dunning')
  await sendDunningEmail({
    subscriberId: sub42,
    email: `tier4-2-${Date.now()}@example.com`,
    customerName: 'Tier 4',
    planName: 'Tier 4 plan',
    amountDue: 5000,
    currency: 'usd',
    nextRetryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    fromName: 'Tier 4 Tester',
  })
  const count42 = await emailsSentCount(sub42)
  console.log(`  emailsSentCount(sub42)=${count42}  ${count42 === 0 ? '✓' : '❌ (expected 0)'}`)

  // === Tier 4.3 — both paused, then clear each ===
  console.log('\n[4.3] both flags SET → both functions skip; then clear one at a time and verify the helper falls open')
  await setPauseFlags(c.id, { paused_at: new Date(), paused_dunning_at: new Date() })
  const sub43wb = await seedSubscriber(c.id, 'winback')
  const sub43dn = await seedSubscriber(c.id, 'dunning')

  // Both functions should skip
  await scheduleExitEmail({
    subscriberId: sub43wb,
    email: `tier4-3-wb-${Date.now()}@example.com`,
    classification: {
      firstMessage: { subject: 'hi', body: 'hi' },
      handoff: null, pause: null, suppress: null,
    } as Parameters<typeof scheduleExitEmail>[0]['classification'],
    fromName: 'Tier 4 Tester',
  })
  await sendDunningEmail({
    subscriberId: sub43dn,
    email: `tier4-3-dn-${Date.now()}@example.com`,
    customerName: 'Tier 4', planName: 'Tier 4', amountDue: 5000, currency: 'usd',
    nextRetryDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    fromName: 'Tier 4 Tester',
  })
  const cWb = await emailsSentCount(sub43wb)
  const cDn = await emailsSentCount(sub43dn)
  console.log(`  both paused  →  winback emails=${cWb}${cWb === 0 ? '✓' : '❌'}  dunning emails=${cDn}${cDn === 0 ? '✓' : '❌'}`)

  // Clear paused_at only; helper for winback should now return false, dunning still true
  await setPauseFlags(c.id, { paused_at: null, paused_dunning_at: new Date() })
  const afterWb = await isCustomerPausedForWinback(sub43wb)
  const afterDn = await isCustomerPausedForDunning(sub43dn)
  console.log(`  cleared paused_at  →  win-back paused=${afterWb}${!afterWb ? '✓' : '❌'}  dunning paused=${afterDn}${afterDn ? '✓' : '❌'}`)

  // Clear paused_dunning_at; both should fall open
  await setPauseFlags(c.id, { paused_at: null, paused_dunning_at: null })
  const finalWb = await isCustomerPausedForWinback(sub43wb)
  const finalDn = await isCustomerPausedForDunning(sub43dn)
  console.log(`  cleared paused_dunning_at  →  win-back paused=${finalWb}${!finalWb ? '✓' : '❌'}  dunning paused=${finalDn}${!finalDn ? '✓' : '❌'}`)

  // Clean up: clear pause flags so subsequent tests are unaffected
  await setPauseFlags(c.id, { paused_at: null, paused_dunning_at: null })

  // Verdict
  const allOk = count41 === 0 && count42 === 0 && cWb === 0 && cDn === 0 && !afterWb && afterDn && !finalWb && !finalDn
  console.log()
  if (allOk) console.log('✓✓✓ Tier 4 verified — split-pause gates work independently and clearably')
  else { console.error('❌ Tier 4 FAILED — see assertions above'); process.exit(1) }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })
