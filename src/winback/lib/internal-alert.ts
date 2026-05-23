/**
 * Internal alerts for ops — enterprise tier detection, reconciliation
 * failures, FX provider outages, etc.
 *
 * Implementation is intentionally minimal: POST a JSON body to
 * INTERNAL_ALERT_CHANNEL (Slack incoming-webhook URL, or any URL that
 * accepts JSON). On missing config or any error, log to console only and
 * return — alerts must never break the user flow.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical'

export type Alert = {
  severity: AlertSeverity
  title: string
  details?: Record<string, unknown>
}

export async function emitInternalAlert(alert: Alert): Promise<void> {
  const url = process.env.INTERNAL_ALERT_CHANNEL
  if (!url) {
    console.warn('[alert]', alert.severity, alert.title, alert.details ?? {})
    return
  }

  const payload = {
    text: `[${alert.severity.toUpperCase()}] ${alert.title}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*[${alert.severity.toUpperCase()}]* ${alert.title}`,
        },
      },
      ...(alert.details
        ? [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '```' + JSON.stringify(alert.details, null, 2) + '```',
              },
            },
          ]
        : []),
    ],
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    console.error('[alert] webhook POST failed', {
      severity: alert.severity,
      title: alert.title,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
