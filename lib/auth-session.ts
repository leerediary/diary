import type { AuthError } from '@supabase/supabase-js'
import { getAuthClient } from '@/lib/supabase'

/**
 * Thin GoTrue surface (Phase 7 / D-01 / D-03).
 *
 * Exposes only the four methods the app needs; all delegate to the
 * getAuthClient() singleton. No module-scope side effects — getAuthClient()
 * is called lazily inside each function body, never at module-import time
 * (RESEARCH Pitfall 6 / D-03 prerender discipline).
 *
 * Callers (Bootstrap.tsx, SignInScreen.tsx, AccountEntry.tsx) import from
 * this module so they do not need to import @supabase/supabase-js directly.
 */

export type { AuthError }

/** Return the current session (or null if not signed in). */
export async function getSession() {
  const { data } = await getAuthClient().auth.getSession()
  return data.session
}

/**
 * Sign in with email + password (D-03).
 * Returns { error: AuthError | null }; on success error is null.
 */
export async function signIn(
  email: string,
  password: string,
): Promise<{ error: AuthError | null }> {
  const { error } = await getAuthClient().auth.signInWithPassword({ email, password })
  return { error: error ?? null }
}

/** Sign out (clears session from localStorage and memory). */
export async function signOut(): Promise<void> {
  await getAuthClient().auth.signOut()
}

/**
 * Subscribe to auth state changes.
 * @returns Unsubscribe function — call it in useEffect cleanup.
 */
export function onAuthStateChange(
  cb: (event: string, session: unknown) => void,
): () => void {
  const { data } = getAuthClient().auth.onAuthStateChange(cb)
  return () => data.subscription.unsubscribe()
}
