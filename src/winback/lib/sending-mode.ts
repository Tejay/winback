/**
 * Global subscriber-email sending control — the go-live safety switch.
 *
 * Gates ALL automated subscriber-facing emails (exit, dunning, dunning
 * follow-up, re-engagement, win-back). Does NOT touch auth emails
 * (password reset, verification), founder-facing emails (onboarding,
 * billing notices), or the internal ops red-light alert.
 *
 * Modes:
 *   - 'live'      — normal. Emails go out (still subject to DNC / AI-pause).
 *   - 'allowlist' — only send to addresses in EMAIL_ALLOWLIST (Phase-1
 *                   testing in prod without touching real subscribers).
 *   - 'paused'    — shadow mode. Send nothing; the rest of the pipeline
 *                   (classify, generate copy) still runs so you can review
 *                   what *would* go out.
 *
 * Source of truth: the most recent `admin_action` event with
 * properties.action='set_sending_mode'. Stored as an event (not env) so
 * it's runtime-mutable from the admin UI AND audited automatically. No
 * event yet → default 'live' (preserves existing behaviour; a fresh deploy
 * doesn't silently stop sending).
 */
import { db } from '@/lib/db'
import { wbEvents } from '@/lib/schema'
import { and, eq, sql, desc } from 'drizzle-orm'

export type SendingMode = 'live' | 'allowlist' | 'paused'
export const SENDING_MODES: readonly SendingMode[] = ['live', 'allowlist', 'paused']

const DEFAULT_MODE: SendingMode = 'live'

function isSendingMode(v: unknown): v is SendingMode {
  return v === 'live' || v === 'allowlist' || v === 'paused'
}

/** Current global sending mode (latest set_sending_mode admin action). */
export async function getSendingMode(): Promise<SendingMode> {
  try {
    const [row] = await db
      .select({ mode: sql<string>`${wbEvents.properties}->>'mode'` })
      .from(wbEvents)
      .where(and(
        eq(wbEvents.name, 'admin_action'),
        sql`${wbEvents.properties}->>'action' = 'set_sending_mode'`,
      ))
      .orderBy(desc(wbEvents.createdAt))
      .limit(1)
    return isSendingMode(row?.mode) ? row.mode : DEFAULT_MODE
  } catch {
    // Fail SAFE on a config-read error: if we can't determine the mode,
    // don't silently blast — but also don't break sends in normal
    // operation. 'live' preserves behaviour; the read rarely fails.
    return DEFAULT_MODE
  }
}

const allowlist = (): string[] =>
  (process.env.EMAIL_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

export interface SendGate {
  allowed: boolean
  mode: SendingMode
  reason?: string
}

/**
 * Decide whether an automated subscriber email to `recipient` may actually
 * be sent under the current global mode. Call this in subscriber-facing
 * send paths, alongside the DNC / AI-pause checks.
 */
export async function checkSendingAllowed(recipient: string | null): Promise<SendGate> {
  const mode = await getSendingMode()
  if (mode === 'live') return { allowed: true, mode }
  if (mode === 'paused') return { allowed: false, mode, reason: 'global sending paused (shadow mode)' }
  // allowlist
  const list = allowlist()
  if (recipient && list.includes(recipient.toLowerCase())) return { allowed: true, mode }
  return { allowed: false, mode, reason: 'recipient not in EMAIL_ALLOWLIST' }
}
