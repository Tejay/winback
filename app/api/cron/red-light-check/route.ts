import { NextRequest } from 'next/server'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { wbEvents } from '@/lib/schema'
import { withCron } from '@/src/winback/lib/cron-wrap'
import { logEvent } from '@/src/winback/lib/events'
import { buildOverviewRollup, type OverviewRollup } from '@/lib/admin/rollups'
import { sendAdminAlert } from '@/lib/admin/admin-alert'
import { getPlatformStripe } from '@/src/winback/lib/platform-stripe'

/**
 * PR 2 — Red-light email alert cron.
 *
 * Schedule: every 5 minutes via vercel.json. Each run:
 *   1. Compute the current red-lights via buildOverviewRollup
 *   2. For each active rule, check the last `red_light_alert_sent` event
 *      for that rule. Skip if a fire happened in the last 15 minutes
 *      (cooldown).
 *   3. If any rules remain, send ONE consolidated email to
 *      ADMIN_ALERT_EMAIL listing them all. Then write a
 *      `red_light_alert_sent` event per rule that was included.
 *
 * The cooldown is per-rule, but emails are bundled — so a single fire
 * lists "errors, floor_emails_sent" together. This beats per-rule emails
 * (fewer inbox interruptions) while still letting each rule cool down
 * independently.
 *
 * PRODUCTION ONLY: a real send happens only when VERCEL_ENV='production'.
 * Dev/preview compute the lights (so the cron is testable) but never email
 * or write cooldown events. `?dryRun=1` never sends in any environment and
 * stays usable everywhere for inspection.
 *
 * Auth: Bearer ${CRON_SECRET} via withCron (Spec 69).
 */
export const maxDuration = 60

const COOLDOWN_MS = 15 * 60 * 1000

export const GET = (req: NextRequest) =>
  withCron('red-light-check', req, async () => {
    const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'

    const rollup = await buildOverviewRollup()
    // Mode-B webhook check is cron-only (a Stripe call), merged into the
    // DB-derived lights from the rollup.
    const lights = [...rollup.redLights, ...(await checkWebhookEndpoints())]
    if (lights.length === 0) {
      return { activeLights: 0, sent: false }
    }

    // Alerts only email from PRODUCTION. Dev/preview (and local runs with the
    // cron secret) still compute the red lights so the cron is exercisable,
    // but never send a real email or write cooldown events. dryRun is exempt
    // — it never sends anyway, so it stays usable everywhere for inspection.
    const isProd = process.env.VERCEL_ENV === 'production'
    if (!isProd && !dryRun) {
      return {
        activeLights: lights.length,
        sent: false,
        skippedReason: `non-production (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'})`,
      }
    }

    // Look up the last-fire timestamp for each active rule
    const ruleNames = lights.map((l) => l.metric)
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS)

    const recentSends = await db
      .select({
        rule: sql<string>`(${wbEvents.properties}->>'rule')`,
        lastAt: sql<Date>`max(${wbEvents.createdAt})`,
      })
      .from(wbEvents)
      .where(and(
        eq(wbEvents.name, 'red_light_alert_sent'),
        gte(wbEvents.createdAt, cooldownCutoff),
        sql`(${wbEvents.properties}->>'rule') = ANY(${ruleNames})`,
      ))
      .groupBy(sql`(${wbEvents.properties}->>'rule')`)

    const rulesInCooldown = new Set(recentSends.map((r) => r.rule))
    const lightsToSend = lights.filter((l) => !rulesInCooldown.has(l.metric))

    if (lightsToSend.length === 0) {
      return {
        activeLights: lights.length,
        sent: false,
        skippedReason: 'all rules in cooldown',
      }
    }

    if (dryRun) {
      return {
        activeLights: lights.length,
        wouldSendRules: lightsToSend.map((l) => l.metric),
        dryRun: true,
      }
    }

    // Build + send the consolidated alert
    const env = process.env.VERCEL_ENV ?? 'development'
    const envLabel = env === 'production' ? 'PROD'
      : env === 'preview' ? 'PREV'
      : 'DEV'
    const subject = `[winback ${envLabel}] red light: ${lightsToSend.map((l) => l.metric).join(', ')}`
    const body = composeAlertBody(lightsToSend, envLabel)

    const result = await sendAdminAlert({ subject, body })

    // Persist per-rule events so future runs respect cooldown. Write
    // them regardless of send success — if Resend was down, we still
    // want to avoid hammering the inbox on the next run while the same
    // outage is happening. The body of the event records send status
    // so failures are diagnosable from the audit log.
    for (const l of lightsToSend) {
      await logEvent({
        name: 'red_light_alert_sent',
        properties: {
          rule:        l.metric,
          kind:        l.kind,
          today:       l.today,
          median7d:    l.median7d,
          sendOk:      result.ok,
          sendError:   result.error ?? null,
          messageId:   result.messageId ?? null,
        },
      })
    }

    return {
      activeLights: lights.length,
      sent: result.ok,
      rules: lightsToSend.map((l) => l.metric),
      messageId: result.messageId ?? null,
      sendError: result.error ?? null,
    }
  })

/**
 * Mode-B webhook delivery check: poll Stripe for the platform's webhook
 * endpoints and raise a red-light if any is not 'enabled'. Stripe disables an
 * endpoint after sustained delivery failures, so a non-enabled endpoint means
 * delivery has stopped and the pipeline will go silent — the one webhook
 * failure mode our endpoint can't observe itself (events never reach us).
 *
 * Cron-only by design: it's a Stripe round-trip, so it lives here (every 5
 * min) rather than in buildOverviewRollup (the 30s admin poll). That makes it
 * an email-alert signal, not a Now-page tile. A Stripe error returns no lights
 * so a transient blip never breaks the rest of the red-light cron.
 */
async function checkWebhookEndpoints(): Promise<OverviewRollup['redLights']> {
  try {
    const eps = await getPlatformStripe().webhookEndpoints.list({ limit: 100 })
    const broken = eps.data.filter((e) => e.status !== 'enabled')
    if (broken.length === 0) return []
    const detail = broken.map((e) => `${e.url} (${e.status})`).join(', ')
    return [{
      metric: 'webhook_endpoint_disabled',
      kind: 'floor',
      today: broken.length,
      median7d: 0,
      summary: `Stripe webhook delivery down — ${broken.length} endpoint(s) not enabled: ${detail}. Stripe has stopped delivering; the pipeline will go silent. Re-enable in the Stripe dashboard.`,
    }]
  } catch (err) {
    console.error('[red-light] webhook endpoint status check failed', err)
    return []
  }
}

function composeAlertBody(lights: OverviewRollup['redLights'], envLabel: string): string {
  const lines: string[] = []
  lines.push(`Winback ${envLabel} — red light alert`)
  lines.push('')
  lines.push(`${lights.length} active red light${lights.length === 1 ? '' : 's'}:`)
  lines.push('')
  for (const l of lights) {
    const marker = l.kind === 'floor' ? '↓' : '↑'
    lines.push(`${marker} ${l.metric}: ${l.summary}`)
    if (l.concentration) {
      lines.push(`    concentrated in ${l.concentration.customerEmail ?? l.concentration.customerId} (${l.concentration.n} of ${l.today})`)
    }
  }
  lines.push('')
  lines.push('Investigate: open /admin')
  lines.push('Cooldown per rule: 15 min. To stop alerts, fix the underlying signal.')
  return lines.join('\n')
}
