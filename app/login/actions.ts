'use server'

/**
 * Spec 29 — server-action sign-in for the no-JS / pre-hydration path.
 *
 * The login form has `action={loginAction}` so that even before React
 * hydrates (or with JS disabled entirely), clicking "Log in" submits via
 * Next.js's built-in server-action transport, hits this function, and
 * either redirects to /dashboard on success or back to /login?error=1.
 * When JS IS hydrated, the form's onSubmit calls preventDefault and uses
 * next-auth/react's signIn() instead, for the same flow without a full
 * page navigation.
 */
import { signIn } from '@/lib/auth'
import { AuthError } from 'next-auth'
import { redirect } from 'next/navigation'

export async function loginAction(formData: FormData) {
  const email = formData.get('email')
  const password = formData.get('password')

  try {
    await signIn('credentials', {
      email,
      password,
      redirectTo: '/dashboard',
    })
  } catch (error) {
    // signIn throws NEXT_REDIRECT to perform the redirect — let that
    // through. Only AuthError is "bad credentials / config" and we should
    // bounce the user back to /login with an error flag.
    if (error instanceof AuthError) {
      redirect('/login?error=1')
    }
    throw error
  }
}
