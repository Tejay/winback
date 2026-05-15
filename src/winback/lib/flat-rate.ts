import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

/**
 * Spec 77 — Per-customer custom flat-rate billing.
 *
 * Mirrors the shape of `isCustomerOnPilot` / `getPilotUntil` from
 * `pilot.ts`. A single nullable INTEGER column on wb_customers gates
 * the standard $99 + perf-fee billing flow:
 *
 *   - NULL  → standard billing (platform sub at $99/mo, perf fees on
 *             each recovery)
 *   - non-NULL → flat-rate (platform sub at custom amount/month, perf
 *             fees skipped — they're already covered by the monthly)
 *
 * The reader is intentionally tiny — one query per call site is fine;
 * call sites are billing operations that are already per-customer.
 */

/**
 * Returns the custom monthly fee in cents if this customer is on a
 * flat-rate deal, or null if they're on standard billing.
 */
export async function getCustomMonthlyCents(customerId: string): Promise<number | null> {
  if (!customerId) return null
  const [row] = await db
    .select({ cents: customers.customMonthlyCents })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  return row?.cents ?? null
}

/**
 * Convenience boolean alias. Use when the caller doesn't need the
 * actual cents value (e.g., perf-fee bypass — it just needs to know
 * "skip this fee").
 */
export async function isCustomerOnFlatRate(customerId: string): Promise<boolean> {
  return (await getCustomMonthlyCents(customerId)) !== null
}
