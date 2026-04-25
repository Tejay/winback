import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { sql, eq } from 'drizzle-orm'
import {
  queryAuditLog,
  listAuditAdmins,
  KNOWN_ACTIONS,
} from '@/lib/admin/audit-log-queries'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/admin/audit-log
 *   ?action=...      one of KNOWN_ACTIONS or omitted
 *   &admin=...       wb_users.id (uuid)
 *   &customer=...    email or uuid (resolved like /admin/events)
 *   &since=24h|7d|30d|90d (default 7d)
 *   &limit=200       default 200, max 500
 *
 * Returns rows from wb_events filtered to admin_action, plus the metadata
 * needed to render filter dropdowns (known action list + admins seen
 * recently).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { searchParams } = req.nextUrl
  const action = searchParams.get('action')?.trim() || null
  const adminUserId = searchParams.get('admin')?.trim() || null
  const customerInput = searchParams.get('customer')?.trim() || null
  const since = searchParams.get('since')?.trim() || '7d'
  const limit = Math.min(Number(searchParams.get('limit')) || 200, 500)

  // Resolve customer email → uuid if needed.
  let customerId: string | null = null
  if (customerInput) {
    if (UUID_RE.test(customerInput)) {
      customerId = customerInput
    } else {
      const [row] = await getDbReadOnly()
        .select({ id: customers.id })
        .from(customers)
        .innerJoin(users, eq(customers.userId, users.id))
        .where(sql`lower(${users.email}) = ${customerInput.toLowerCase()}`)
        .limit(1)
      if (!row) {
        return NextResponse.json({
          rows: [],
          knownActions: KNOWN_ACTIONS,
          admins: [],
          customerNotFound: true,
        })
      }
      customerId = row.id
    }
  }

  const [rows, admins] = await Promise.all([
    queryAuditLog({ action, adminUserId, customerId, since, limit }),
    listAuditAdmins('90d'),
  ])

  return NextResponse.json({
    rows,
    knownActions: KNOWN_ACTIONS,
    admins,
  })
}
