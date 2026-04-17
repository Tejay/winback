import { NextResponse } from 'next/server'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and, isNotNull, isNull, inArray, sql } from 'drizzle-orm'
import { sendEmail } from '@/src/winback/lib/email'

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

  // Find matching subscribers with trigger keywords
  let matchesFound = 0

  const matchedSubs = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        inArray(churnedSubscribers.status, ['pending', 'contacted']),
        eq(churnedSubscribers.doNotContact, false),
        isNotNull(churnedSubscribers.triggerKeyword),
        isNotNull(churnedSubscribers.winBackBody),
        isNull(churnedSubscribers.reengagementSentAt),
        sql`${content} ILIKE '%' || ${churnedSubscribers.triggerKeyword} || '%'`
      )
    )

  const fromName = customer.founderName ?? 'The team'

  for (const sub of matchedSubs) {
    if (!sub.email || !sub.winBackBody || !sub.winBackSubject) continue

    try {
      const { messageId } = await sendEmail({
        to: sub.email,
        subject: sub.winBackSubject,
        body: sub.winBackBody,
        fromName,
        subscriberId: sub.id,
      })

      await db.insert(emailsSent).values({
        subscriberId: sub.id,
        gmailMessageId: messageId,
        type: 'win_back',
        subject: sub.winBackSubject,
      })

        await db
          .update(churnedSubscribers)
          .set({ status: 'contacted', updatedAt: new Date() })
          .where(eq(churnedSubscribers.id, sub.id))

        matchesFound++
    } catch (err) {
      console.error(`Failed to send win-back email to ${sub.email}:`, err)
    }
  }

  return NextResponse.json({ success: true, keywordsFound, matchesFound })
}
