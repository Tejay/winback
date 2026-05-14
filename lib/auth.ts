import NextAuth, { CredentialsSignin } from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db, getDbReadOnly } from '@/lib/db'
import { users } from '@/lib/schema'
import { eq } from 'drizzle-orm'

/**
 * Spec 32 — surfaced to the login form so it can render a "please verify
 * your email" message + Resend button instead of the generic "Invalid
 * email or password". NextAuth catches CredentialsSignin subclasses and
 * exposes `code` on the signIn result.
 */
class UnverifiedEmailError extends CredentialsSignin {
  code = 'UNVERIFIED_EMAIL'
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: 'jwt' },
  pages:   { signIn: '/login' },
  providers: [
    Credentials({
      credentials: {
        email:    { label: 'Email',    type: 'email'    },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined
        const password = credentials?.password as string | undefined
        if (!email || !password) return null

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)

        if (!user) return null

        const valid = await bcrypt.compare(password, user.passwordHash)
        if (!valid) return null

        // Spec 32 — refuse unverified accounts. Throwing a typed error
        // (rather than returning null) lets the login form distinguish
        // bad-credentials from needs-verification and render a "Resend"
        // button. The column is the single source of truth — no env-var
        // bypass anywhere on the login path.
        if (!user.emailVerifiedAt) {
          throw new UnverifiedEmailError()
        }

        return { id: user.id, email: user.email, name: user.name }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.id = user.id
      // Spec 68 — impersonation: the start/stop endpoints mutate the
      // session cookie directly via next-auth/jwt encode(). This callback
      // is only invoked on credentials-signin and on subsequent same-token
      // refreshes; in both cases `token.impersonator` (if present) is
      // already in the payload from the prior issuance and we pass it
      // through unchanged.
      return token
    },
    session({ session, token }) {
      if (session.user) session.user.id = token.id as string
      if (token.impersonator) session.impersonator = token.impersonator
      return session
    },
  },
})

/**
 * Spec 68 — NextAuth v5 picks the session cookie name based on whether
 * the request URL is HTTPS. Helper centralises the detection so both
 * the impersonate-start and stop-impersonating endpoints encode against
 * the same cookie NextAuth itself reads from.
 */
export function getSessionCookieName(reqUrl?: string): string {
  const url = reqUrl
    ? new URL(reqUrl)
    : new URL(process.env.NEXTAUTH_URL || 'http://localhost')
  return url.protocol === 'https:'
    ? '__Secure-authjs.session-token'
    : 'authjs.session-token'
}

/**
 * Spec 25 — Admin gate for /admin pages and /api/admin/* routes.
 *
 * Returns `{ userId }` for an authenticated admin, or `{ error, status }` for
 * everyone else. Uses the read-only DB connection for the lookup so even this
 * gating query can't mutate anything.
 *
 * Usage in an API route:
 *   const auth = await requireAdmin()
 *   if ('error' in auth) return Response.json({ error: auth.error }, { status: auth.status })
 *   // ...auth.userId is the admin
 *
 * Usage in a server component:
 *   const result = await requireAdmin()
 *   if ('error' in result) redirect('/login')   // or '/' for the 403 case
 */
export type RequireAdminResult =
  | { userId: string }
  | { error: string; status: 401 | 403 }

/**
 * Non-throwing variant of requireAdmin — returns a boolean for UI use
 * (e.g. conditionally rendering an Admin nav link). Server gates on
 * `/admin/*` still use requireAdmin separately.
 */
export async function userIsAdmin(userId: string): Promise<boolean> {
  try {
    const [row] = await getDbReadOnly()
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return !!row?.isAdmin
  } catch {
    const [row] = await db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return !!row?.isAdmin
  }
}

export async function requireAdmin(): Promise<RequireAdminResult> {
  const session = await auth()
  if (!session?.user?.id) return { error: 'Not signed in', status: 401 }

  try {
    const [row] = await getDbReadOnly()
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
    if (!row?.isAdmin) return { error: 'Admin only', status: 403 }
    return { userId: session.user.id }
  } catch (err) {
    // Read-only role isn't provisioned yet (DATABASE_URL_READONLY missing) —
    // fall back to the read/write connection. This keeps /admin reachable
    // pre-launch while infra catches up; production must have the env set.
    console.warn('requireAdmin: dbReadOnly unavailable, falling back to db', err)
    const [row] = await db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
    if (!row?.isAdmin) return { error: 'Admin only', status: 403 }
    return { userId: session.user.id }
  }
}
