/**
 * Build / deploy metadata for the admin sidebar footer.
 *
 * Reads Vercel-set env vars (VERCEL_ENV, VERCEL_GIT_COMMIT_SHA, …) at
 * request time. On local `next dev` these are unset and we fall back to
 * "development" + null SHA. BUILD_TIME is stamped at config-eval time
 * via next.config.ts so the sidebar can show "deployed Nh ago" without
 * an extra request.
 *
 * Called only from the admin server layout — keep it cheap, no I/O.
 */
export type BuildEnv = 'production' | 'preview' | 'development'

export interface BuildInfo {
  env: BuildEnv
  /** Short 7-char SHA for display. Null when running locally. */
  sha: string | null
  /** Full SHA — useful as a tooltip. */
  fullSha: string | null
  /** Author of the deploying commit (Vercel-supplied). */
  author: string | null
  /** Build time, ISO from next.config.ts. Null when no stamp present. */
  buildTime: Date | null
}

export function getBuildInfo(): BuildInfo {
  const env = parseEnv(process.env.VERCEL_ENV)
  const fullSha = process.env.VERCEL_GIT_COMMIT_SHA ?? null
  const sha = fullSha ? fullSha.slice(0, 7) : null
  const author = process.env.VERCEL_GIT_COMMIT_AUTHOR_NAME ?? null
  const buildTimeRaw = process.env.BUILD_TIME ?? null
  const buildTime = buildTimeRaw ? new Date(buildTimeRaw) : null
  return { env, sha, fullSha, author, buildTime }
}

function parseEnv(raw: string | undefined): BuildEnv {
  if (raw === 'production') return 'production'
  if (raw === 'preview') return 'preview'
  return 'development'
}
