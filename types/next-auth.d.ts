import { DefaultSession } from 'next-auth'
import { DefaultJWT } from 'next-auth/jwt'

/** Spec 68 — admin impersonation marker carried in the session JWT. */
export interface ImpersonatorClaim {
  adminId: string
  adminEmail: string
  startedAt: string  // ISO timestamp
  expiresAt: string  // ISO timestamp; cookie hard-expires here
}

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
    } & DefaultSession['user']
    impersonator?: ImpersonatorClaim
  }
  interface User {
    id: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    id: string
    impersonator?: ImpersonatorClaim
  }
}
