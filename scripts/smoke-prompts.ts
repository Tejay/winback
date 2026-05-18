// Smoke test for the externalized LLM prompts (refactor PR).
//
// Calls every one of the 7 LLM-driven flows once with synthetic inputs
// to prove each prompt in /prompts/*.md is correctly wired through
// prompts.generated.ts into the production code path and produces a
// schema-valid response.
//
// Usage:
//   npx tsx --env-file=.env.local scripts/smoke-prompts.ts
//
// Cost: ~$0.02 in Anthropic Haiku tokens (7 small calls).

import Anthropic from '@anthropic-ai/sdk'
import fs from 'node:fs'
import path from 'node:path'
import { classifySubscriber } from '../src/winback/lib/classifier'

// Mirror the .env.local fallback used by getClient() in classifier.ts and
// improvement-match.ts. Inside Claude Code's shell, ANTHROPIC_API_KEY is set
// to an empty string in system env, which overrides what --env-file=.env.local
// loads. The fallback reads the key directly from .env.local.
function resolveApiKey(): string {
  const fromEnv = process.env.ANTHROPIC_API_KEY
  if (fromEnv && fromEnv.startsWith('sk-')) return fromEnv
  const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8')
  const m = envFile.match(/^ANTHROPIC_API_KEY="?([^"\n]+)"?$/m)
  if (!m?.[1]) throw new Error('ANTHROPIC_API_KEY not found in env or .env.local')
  return m[1]
}
import {
  checkImprovementMatch,
  generateImprovementEmail,
  sanityCheckEmail,
  generatePromotionEmail,
  sanityCheckPromotionEmail,
  type PromotionForEmail,
} from '../src/winback/lib/improvement-match'
import { CLUSTER_SYSTEM_PROMPT } from '../src/winback/lib/prompts.generated'

type Status = 'PASS' | 'FAIL'
interface Result { name: string; status: Status; detail: string }
const results: Result[] = []

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail })
  console.log(`${ok ? '✓' : '✗'} ${name.padEnd(28)} ${detail}`)
}

async function main(): Promise<void> {
  console.log('Running smoke checks against 7 externalized prompts...\n')

  // ------------------------------------------------------------
  // 1. CLASSIFIER_SYSTEM_PROMPT — Tier 2 enum-only path
  // ------------------------------------------------------------
  try {
    const c = await classifySubscriber(
      {
        stripeCustomerId:     'cus_smoke_test',
        stripeSubscriptionId: 'sub_smoke',
        stripePriceId:        null,
        email:                'smoke@example.com',
        name:                 'Smoke Test',
        planName:             'Pro',
        mrrCents:             4900,
        tenureDays:           90,
        everUpgraded:         false,
        nearRenewal:          false,
        paymentFailures:      0,
        previousSubs:         0,
        stripeEnum:           'too_expensive',
        stripeComment:        null,
        conversationThread:   [],
        billingPortalClicked: false,
        cancelledAt:          new Date(),
      },
      { productName: 'TestApp', founderName: 'Alex' },
    )
    const ok =
      (c.tier === 1 || c.tier === 2) &&
      c.firstMessage !== null &&
      c.firstMessage.body.length > 0 &&
      c.firstMessage.body.length <= 250
    record('classifier', ok, `tier=${c.tier} bodyLen=${c.firstMessage?.body.length ?? 0}/250`)
  } catch (err) {
    record('classifier', false, String(err))
  }

  // ------------------------------------------------------------
  // 2. MATCH_SYSTEM_PROMPT — clear semantic match
  // ------------------------------------------------------------
  const improvement = {
    id:           '550e8400-e29b-41d4-a716-446655440000',
    title:        'Zapier-HubSpot integration',
    description: 'Two-way sync between Zapier and HubSpot, no code required.',
    dateShipped: '2026-03-01',
  }
  try {
    const m = await checkImprovementMatch(
      'Wants Zapier integration for HubSpot sync',
      improvement,
    )
    record('match-check', m.matches === true && m.confidence >= 0.7, `matches=${m.matches} confidence=${m.confidence.toFixed(2)}`)
  } catch (err) {
    record('match-check', false, String(err))
  }

  // ------------------------------------------------------------
  // 3. GENERATE_SYSTEM_PROMPT — improvement email
  // ------------------------------------------------------------
  let draft = { subject: '', body: '' }
  try {
    const e = await generateImprovementEmail({
      improvement,
      triggerNeed:    'Wants Zapier integration for HubSpot sync',
      subscriberName: 'Jamie',
      founderName:    'Alex',
    })
    if (e) draft = e
    const ok = !!e && e.body.length > 0 && e.body.length <= 250
    record('improvement-email', ok, `subject="${e?.subject ?? '?'}" bodyLen=${e?.body.length ?? 0}/250`)
  } catch (err) {
    record('improvement-email', false, String(err))
  }

  // ------------------------------------------------------------
  // 4. SANITY_SYSTEM_PROMPT — improvement-email sanity gate
  // ------------------------------------------------------------
  try {
    const checkInput = draft.body
      ? draft
      : { subject: 'About your Zapier ask', body: "Hi Jamie,\n\nI shipped the Zapier-HubSpot integration you asked for — two-way sync, no code. Worth another look?\n\n— Alex" }
    const s = await sanityCheckEmail({
      triggerNeed: 'Wants Zapier integration for HubSpot sync',
      improvement,
      email:       checkInput,
    })
    record('improvement-sanity', s.pass === true, `pass=${s.pass} reason="${s.reason}"`)
  } catch (err) {
    record('improvement-sanity', false, String(err))
  }

  // ------------------------------------------------------------
  // 5. GENERATE_PROMOTION_SYSTEM_PROMPT — discount email
  // ------------------------------------------------------------
  const promotion: PromotionForEmail = {
    code:             'SMOKE25',
    percentOff:       25,
    amountOffCents:   null,
    currency:         null,
    duration:         'repeating',
    durationInMonths: 3,
  }
  let promoDraft = { subject: '', body: '' }
  try {
    const e = await generatePromotionEmail({
      promotion,
      triggerNeed:    'Too expensive for our small team right now',
      subscriberName: 'Jamie',
      founderName:    'Alex',
    })
    if (e) promoDraft = e
    const ok = !!e && e.body.length > 0 && e.body.length <= 250
    record('promotion-email', ok, `subject="${e?.subject ?? '?'}" bodyLen=${e?.body.length ?? 0}/250`)
  } catch (err) {
    record('promotion-email', false, String(err))
  }

  // ------------------------------------------------------------
  // 6. SANITY_PROMO_SYSTEM_PROMPT — promotion sanity gate
  // ------------------------------------------------------------
  try {
    const checkInput = promoDraft.body
      ? promoDraft
      : { subject: 'About price', body: "Hi Jamie,\n\nSaw cost was the sticking point — I've put 25% off the next 3 months on the table with code SMOKE25. Worth another look?\n\n— Alex" }
    const s = await sanityCheckPromotionEmail({
      promotion,
      triggerNeed: 'Too expensive for our small team right now',
      email:       checkInput,
    })
    record('promotion-sanity', s.pass === true, `pass=${s.pass} reason="${s.reason}"`)
  } catch (err) {
    record('promotion-sanity', false, String(err))
  }

  // ------------------------------------------------------------
  // 7. CLUSTER_SYSTEM_PROMPT — themes from 5 fake cancellations
  // Direct Anthropic call (the full clusterCancellationsForCustomer
  // is DB-bound — we just want to prove the prompt parses and a
  // valid themes response comes back).
  // ------------------------------------------------------------
  try {
    const userPrompt = `MERCHANT'S SHIPPED IMPROVEMENTS:
(none — merchant has not shipped any improvements yet)

UNMATCHED CANCELLATIONS (5 subscribers, last 90 days):
- id=550e8400-e29b-41d4-a716-446655440001 | category=Feature | cancelled 2026-04-15 | "Wanted Slack integration for new-order notifications"
- id=550e8400-e29b-41d4-a716-446655440002 | category=Feature | cancelled 2026-04-20 | "No Slack support, had to use email which my team ignores"
- id=550e8400-e29b-41d4-a716-446655440003 | category=Feature | cancelled 2026-04-22 | "Needed Slack alerts when orders come in"
- id=550e8400-e29b-41d4-a716-446655440004 | category=Other   | cancelled 2026-04-25 | "Pricing page was confusing"
- id=550e8400-e29b-41d4-a716-446655440005 | category=Feature | cancelled 2026-05-01 | "Native Slack notifications would be a must-have"

Cluster the cancellations into themes per the rules.`

    const client = new Anthropic({ apiKey: resolveApiKey() })
    const response = await client.messages.create({
      model:       'claude-haiku-4-5-20251001',
      max_tokens:  2000,
      temperature: 0,
      system:      CLUSTER_SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userPrompt }],
    })
    const raw     = response.content[0].type === 'text' ? response.content[0].text : ''
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim()
    const parsed  = JSON.parse(cleaned) as { themes?: Array<{ title: string; subscriberIds: string[] }> }
    const slackTheme = parsed.themes?.find((t) => /slack/i.test(t.title))
    const ok = Array.isArray(parsed.themes) && parsed.themes.length >= 1 && !!slackTheme && slackTheme.subscriberIds.length >= 3
    record('cluster', ok, `themes=${parsed.themes?.length ?? 0} slackTheme="${slackTheme?.title ?? 'missing'}" slackSize=${slackTheme?.subscriberIds.length ?? 0}`)
  } catch (err) {
    record('cluster', false, String(err))
  }

  // ------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------
  console.log('\n=== Summary ===')
  const passed = results.filter((r) => r.status === 'PASS').length
  console.log(`${passed}/${results.length} prompts passed`)
  const failed = results.filter((r) => r.status === 'FAIL')
  if (failed.length > 0) {
    console.log('\nFailures:')
    failed.forEach((r) => console.log(`  • ${r.name}: ${r.detail}`))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('Smoke test crashed:', err)
  process.exit(1)
})
