import { NextResponse } from 'next/server'

/**
 * DEPRECATED — replaced by Spec 65's per-entry /api/improvements model.
 *
 * The old free-text changelog blob is retired. Use:
 *   POST /api/improvements            — create a new improvement
 *   GET  /api/improvements            — list current merchant's improvements
 *   PATCH /api/improvements/[id]      — edit
 *   POST /api/improvements/[id]/archive   — soft-delete (with 2-checkbox confirm)
 *   POST /api/improvements/[id]/restore   — un-archive
 *
 * Returning 410 Gone (not 404) so any old client knows the endpoint
 * existed but has been intentionally retired. The customer.changelog_text
 * column is kept for the backfill into wb_improvements; nothing writes
 * to it anymore.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: 'Endpoint retired',
      message: 'Use /api/improvements for the per-entry replacement (Spec 65). The old free-text changelog blob is no longer accepted.',
    },
    { status: 410 },
  )
}
