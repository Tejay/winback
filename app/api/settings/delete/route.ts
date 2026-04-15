import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { slugifyWorkspaceName, confirmationMatches } from '@/src/winback/lib/workspace'
import { computeOpenObligations } from '@/src/winback/lib/obligations'

const bodySchema = z.object({ confirmation: z.string().min(1).max(200) })

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const userId = session.user.id

  const [customer] = await db
    .select({
      id: customers.id,
      productName: customers.productName,
    })
    .from(customers)
    .where(eq(customers.userId, userId))
    .limit(1)

  const email = session.user.email ?? ''
  const expected = slugifyWorkspaceName(customer?.productName, email)

  if (!confirmationMatches(parsed.data.confirmation, expected)) {
    return NextResponse.json({ error: 'Confirmation does not match' }, { status: 400 })
  }

  // Obligation guard — /terms §3 says 12-month attribution billing is not
  // waived by deletion. Re-check server-side; never trust the client.
  if (customer) {
    const obligations = await computeOpenObligations(customer.id)
    if (obligations.openObligationCents > 0) {
      return NextResponse.json(
        {
          error: 'Open obligations remain; settle or pause before deleting.',
          openObligationCents: obligations.openObligationCents,
          liveCount: obligations.liveCount,
        },
        { status: 409 },
      )
    }
  }

  // recoveries has no ON DELETE CASCADE — must delete explicitly first.
  // Everything else cascades from users → customers → churned_subscribers → emails_sent.
  if (customer) {
    await db.delete(recoveries).where(eq(recoveries.customerId, customer.id))
  }
  await db.delete(users).where(eq(users.id, userId))

  return NextResponse.json({ ok: true })
}
