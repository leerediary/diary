import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

// Browser client: anon/publishable key only. The secret-key path
// (createServerClient / SUPABASE_SECRET_KEY) was deleted in Phase 3 (SEC-02)
// so no secret can enter the client bundle. Phase 5's remote sync adapter
// will also use the anon key.
export function createBrowserClient() {
  return createClient(url, anonKey)
}

// Authenticated session singleton (Phase 7 / D-01 / D-03).
//
// Uses the same anon/publishable key — no secret in the bundle (SEC-02 intact).
// Identity is carried by a GoTrue-issued JWT (Authorization: Bearer header),
// persisted in localStorage['supabase.auth.token'] and auto-refreshed.
//
// IMPORTANT: getAuthClient() MUST ONLY be called from useEffect or async
// handlers (never at module scope or render time). The GoTrueClient constructor
// accesses isBrowser()/localStorage — in Node (prerender pass) it falls back
// to in-memory storage and the session would not persist (RESEARCH Pitfall 6).
let _authClient: ReturnType<typeof createClient> | null = null

export function getAuthClient() {
  if (!_authClient) {
    _authClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,      // localStorage['supabase.auth.token']
        autoRefreshToken: true,    // no manual refresh needed
        detectSessionInUrl: false, // no OAuth/magic-link redirect in this app
      },
    })
  }
  return _authClient
}
