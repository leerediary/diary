// lib/sqlite-bridge.ts — TypeScript contract for the Swift-injected window.diaryBridge
//
// INVARIANT: this module is tree-shaken from web builds — it is only imported by
// lib/sqlite-repository.ts, which in turn is only instantiated by
// lib/repository-provider.ts when `window.diaryBridge` is present at runtime
// (i.e. inside the native WKWebView shell — Plan 08-02). `getBridge()` MUST NEVER
// be called during Next.js prerender: the Node prerender pass has no `window`,
// and the constructor of SqliteLocalRepository deliberately does NOT touch the
// bridge — every bridge access happens inside a method that is reached only from
// a client effect/handler, after Swift has injected `window.diaryBridge` via the
// `atDocumentStart` WKUserScript.
//
// Runtime presence of `window.diaryBridge` is the SINGLE source of truth for the
// native-vs-web branch (D-04 / D-08 — see repository-provider.ts). No build-time
// env-detection branch is used; the Swift shell injection is the only signal.
//
// Source contract reproduced verbatim from 08-RESEARCH.md Example 4.

export interface DiaryBridge {
  execute(sql: string, params: unknown[]): Promise<void>
  query<T>(sql: string, params: unknown[]): Promise<T[]>
}

declare global {
  interface Window {
    diaryBridge?: DiaryBridge
  }
}

export function getBridge(): DiaryBridge {
  if (typeof window === 'undefined' || !window.diaryBridge) {
    throw new Error('[SqliteRepository] diaryBridge not available — not running in native shell')
  }
  return window.diaryBridge
}
