import { DefaultSession } from 'next-auth'
import { DefaultJWT } from 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      email: string
      name?: string | null
    } & DefaultSession['user']
  }
  interface User {
    id: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    id: string
  }
}
