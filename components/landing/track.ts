/**
 * Client-side anonymous funnel tracking for the marketing pages.
 *
 * Posts to the public `/api/track` endpoint (allowlisted, no session). Uses
 * `navigator.sendBeacon` so a `cta_clicked` event survives the navigation
 * that follows the click; falls back to `fetch(..., { keepalive: true })`.
 *
 * Only the two anonymous top-of-funnel events are sent from here:
 *   - landing_viewed  (once per browser session)
 *   - cta_clicked     (with a `location`, e.g. "hero" | "pricing")
 */

type AnonEvent = 'landing_viewed' | 'cta_clicked'

export function track(event: AnonEvent, location?: string): void {
  if (typeof window === 'undefined') return
  try {
    const payload = JSON.stringify({ event, location })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([payload], { type: 'application/json' })
      navigator.sendBeacon('/api/track', blob)
      return
    }
    void fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => {})
  } catch {
    // Telemetry must never break the page.
  }
}

/**
 * Fire `event` at most once per browser session (sessionStorage guard).
 * Used for `landing_viewed` so re-renders / client navigations within a
 * session don't double-count.
 */
export function trackOnce(event: AnonEvent, location?: string): void {
  if (typeof window === 'undefined') return
  try {
    const key = `wb_tracked:${event}`
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
  } catch {
    // sessionStorage can throw (private mode / disabled) — still fire once.
  }
  track(event, location)
}
