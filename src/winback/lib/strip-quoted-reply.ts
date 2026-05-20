/**
 * Strip quoted history, forwarded blocks, and signatures from an inbound
 * email reply, leaving just what the person actually typed.
 *
 * Why: when a subscriber replies to our exit email, their client appends
 * the full quoted thread ("On <date> <name> wrote:" + the original body,
 * often with the reply+<id>@reply.winbackflow.co address). Storing that
 * pollutes the dashboard snippet and the drawer conversation, and feeds
 * noise to the classifier.
 *
 * This is a best-effort heuristic — clients quote differently — so it errs
 * toward keeping the reply intact: it only cuts at well-known markers and
 * never returns more than the original.
 */

/**
 * Find the earliest index where quoted/forwarded/signature content begins,
 * or -1 if none is found.
 */
function findCutIndex(text: string): number {
  const candidates: number[] = []
  const push = (m: RegExpMatchArray | null) => {
    if (m && m.index != null) {
      // Skip a leading newline captured in group 1 so we cut at the marker
      // line itself, not the blank line before it.
      candidates.push(m.index + (m[1] ? m[1].length : 0))
    }
  }

  // "On <date>, <name> wrote:" (Gmail, Apple Mail). The attribution often
  // wraps across lines when the address is long, so allow up to ~300 chars
  // between "On" and "wrote:".
  push(text.match(/(\n)[ \t]*On\b[\s\S]{0,300}?\bwrote:/))
  // Outlook / generic forwarded markers.
  push(text.match(/(\n)[ \t]*-{2,}\s*Original Message\s*-{2,}/i))
  push(text.match(/(\n)[ \t]*-{2,}\s*Forwarded message\s*-{2,}/i))
  push(text.match(/(\n)_{5,}[ \t]*(?=\n|$)/)) // Outlook horizontal rule
  // Outlook header block: "From: …" immediately followed by Sent:/Date:.
  push(text.match(/(\n)[ \t]*From:[ \t].+\n[ \t]*(?:Sent|Date|To):[ \t]/i))
  // First fully-quoted line (">").
  push(text.match(/(\n)[ \t]*>/))
  // Mobile / client sign-offs.
  push(text.match(/(\n)[ \t]*Sent from my\b/i))
  push(text.match(/(\n)[ \t]*Get Outlook for\b/i))
  // RFC 3676 signature delimiter ("-- " on its own line).
  push(text.match(/(\n)-- ?(?=\n|$)/))

  return candidates.length ? Math.min(...candidates) : -1
}

export function stripQuotedReply(raw: string | null | undefined): string {
  if (!raw) return ''
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const cut = findCutIndex(text)
  const head = cut >= 0 ? text.slice(0, cut) : text
  // Tidy: drop trailing whitespace per line, collapse 3+ blank lines, trim.
  return head
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
