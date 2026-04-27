import { NextResponse } from 'next/server'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and, isNotNull, isNull, inArray, sql } from 'drizzle-orm'
import { sendEmail, resolveFounderNotificationEmail, recordEmailSentIdempotent } from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'
import { matchChangelogToSubscribers, generateWinBackEmail } from '@/src/winback/lib/changelog-match'
import { buildChangelogMatchAfterHandoffNotification } from '@/src/winback/lib/founder-handoff-email'
import { Resend } from 'resend'

const changelogSchema = z.object({
  content: z.string().min(1),
})

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key || !key.startsWith('sk-')) {
    try {
      const fs = require('fs')
      const path = require('path')
      const envFile = fs.readFileSync(path.join(process.cwd(), '.env.local'), 'utf8')
      const match = envFile.match(/^ANTHROPIC_API_KEY="?([^"\n]+)"?$/m)
      if (match?.[1]) return new Anthropic({ apiKey: match[1] })
    } catch {}
    throw new Error('ANTHROPIC_API_KEY is not set or empty')
  }
  return new Anthropic({ apiKey: key })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const parsed = changelogSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 })
  }

  const content = parsed.data.content

  // Save changelog
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  await db
    .update(customers)
    .set({ changelogText: content, updatedAt: new Date() })
    .where(eq(customers.userId, session.user.id))

  // Extract keywords via LLM
  let keywordsFound: string[] = []
  try {
    const response = await getAnthropicClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      temperature: 0,
      max_tokens: 200,
      system: 'Return ONLY a JSON array of lowercase keyword strings. No other text.',
      messages: [
        {
          role: 'user',
          content: `Extract 3-8 keywords from this changelog. Focus on feature names, integration names, and bug fixes. Example output: ["zapier","csv","calendar"]\nChangelog: ${content}`,
        },
      ],
    })

    const raw = response.content[0].type === 'text' ? response.content[0].text : '[]'
    const parsedKeywords = z.array(z.string()).safeParse(JSON.parse(raw))
    if (parsedKeywords.success) {
      keywordsFound = parsedKeywords.data
    }
  } catch (err) {
    console.error('Keyword extraction failed:', err)
  }

  // Spec 19a — broaden the candidate query (no ILIKE substring filter).
  // Prefer triggerNeed (rich description); fall back to triggerKeyword for legacy rows.
  let matchesFound = 0

  const candidates = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        inArray(churnedSubscribers.status, ['pending', 'contacted']),
        eq(churnedSubscribers.doNotContact, false),
        isNull(churnedSubscribers.reengagementSentAt),
        // Subscriber must have SOMETHING for the matcher to read
        sql`(${churnedSubscribers.triggerNeed} IS NOT NULL OR ${churnedSubscribers.triggerKeyword} IS NOT NULL)`
      )
    )

  if (candidates.length === 0) {
    return NextResponse.json({ success: true, keywordsFound, matchesFound: 0 })
  }

  // Spec 19a — single LLM re-rank call decides which subscribers' needs are addressed
  const matchedIds = await matchChangelogToSubscribers(
    content,
    candidates.map(c => ({
      id: c.id,
      need: c.triggerNeed ?? c.triggerKeyword!,
    }))
  )

  if (matchedIds.size === 0) {
    // Either honest no-matches or an LLM failure (logged inside the matcher).
    return NextResponse.json({ success: true, keywordsFound, matchesFound: 0 })
  }

  const matchedSubs = candidates.filter(c => matchedIds.has(c.id))
  const fromName = customer.founderName ?? 'The team'

  for (const sub of matchedSubs) {
    if (!sub.email) continue

    try {
      // Spec 21b — if subscriber is handed off, don't auto-send. Notify the
      // founder instead so they can decide whether to mention this in their
      // ongoing personal conversation. Respect snooze (spec 21c).
      // Spec 22a — if subscriber is handed off OR has AI paused, notify the
      // founder instead of auto-sending. Mute notifications when handoff+snooze
      // is active (same rule as inbound reply route).
      const isHandedOff = sub.founderHandoffAt && !sub.founderHandoffResolvedAt
      const isPaused = sub.aiPausedUntil && sub.aiPausedUntil.getTime() > Date.now()

      if (isHandedOff || isPaused) {
        const shouldNotify = !(isHandedOff && isPaused)

        if (shouldNotify) {
          const recipient = await resolveFounderNotificationEmail(customer.id)
          if (recipient) {
            const { subject, body } = await buildChangelogMatchAfterHandoffNotification({
              subscriber: {
                id: sub.id,
                email: sub.email,
                name: sub.name,
                planName: sub.planName,
                mrrCents: sub.mrrCents,
                cancellationReason: sub.cancellationReason,
                triggerNeed: sub.triggerNeed,
                cancelledAt: sub.cancelledAt,
                stripeComment: sub.stripeComment,
                replyText: sub.replyText,
              },
              founderName: fromName,
              changelogText: content,
            })
            const resend = new Resend(process.env.RESEND_API_KEY!)
            await resend.emails.send({
              from: `Winback <noreply@winbackflow.co>`,
              to: recipient,
              subject,
              text: body,
            })
            console.log('Changelog-match notification sent to founder (handoff/pause) for:', sub.email)
          }
        } else {
          console.log('Changelog match while handoff is snoozed — no notification:', sub.email)
        }
        // Skip auto-send to subscriber regardless of notification state
        continue
      }

      // Spec 19c — generate a concrete win-back email at match time.
      // Falls back to legacy pre-written winBackBody if generation fails or
      // the subscriber predates spec 19c (unlikely after backfill).
      const need = sub.triggerNeed ?? sub.triggerKeyword ?? ''
      const generated = need
        ? await generateWinBackEmail({
            changelogText: content,
            triggerNeed: need,
            subscriberName: sub.name,
            founderName: fromName,
          })
        : null

      const subject = generated?.subject ?? sub.winBackSubject
      const body    = generated?.body    ?? sub.winBackBody

      if (!subject || !body) {
        console.warn(`Skipping win-back to ${sub.email} — no generated email and no legacy body`)
        continue
      }

      const { messageId } = await sendEmail({
        to: sub.email,
        subject,
        body,
        fromName,
        subscriberId: sub.id,
      })

      // Spec 28 — idempotent on (subscriber_id, type) per migration 023.
      await recordEmailSentIdempotent(
        {
          subscriberId: sub.id,
          gmailMessageId: messageId,
          type: 'win_back',
          subject,
        },
        'changelogWinBack',
      )

      await db
        .update(churnedSubscribers)
        .set({ status: 'contacted', updatedAt: new Date() })
        .where(eq(churnedSubscribers.id, sub.id))

      logEvent({
        name: 'email_sent',
        customerId: customer.id,
        properties: {
          subscriberId: sub.id,
          emailType: 'win_back',
          subject,
          messageId,
          generatedAtMatchTime: !!generated,
        },
      })

      matchesFound++
    } catch (err) {
      console.error(`Failed to send win-back email to ${sub.email}:`, err)
    }
  }

  return NextResponse.json({ success: true, keywordsFound, matchesFound })
}
