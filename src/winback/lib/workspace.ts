/**
 * Workspace name used as the typed-confirmation token on the delete flow.
 * Deterministic on both client (rendered) and server (validated) — must match.
 */
export function slugifyWorkspaceName(input: string | null | undefined, fallback: string): string {
  const raw = (input ?? '').trim() || fallback
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function confirmationMatches(typed: string, expected: string): boolean {
  return typed.trim().toLowerCase() === expected
}
