/**
 * Module-scope sync-state pub/sub (framework-agnostic, no React import).
 *
 * Mirrors the lib/bootstrap.ts module-scope `inFlight` coalescing pattern:
 * module-scope variables survive component remounts across App Router
 * navigation (React state would reset on unmount).
 *
 * State shape:
 *   unsyncedCount — D-10 threshold-gated count of outbox entries that have
 *                   been persistently unsynced (failCount >= 3 OR oldest entry
 *                   age > 5 min). Zero in steady state → D-04 invisible.
 *   conflictDates — dates on which a journal conflict was merged this cycle.
 *                   D-08: raised by SyncEngine.mergeJournalConflict.
 *
 * No side effects on import. SyncBanner subscribes in its own useEffect.
 */

export interface SyncStateShape {
  unsyncedCount: number
  conflictDates: string[]
  /** Phase 7 / D-07: true when the last remote call was rejected due to an
   *  auth/permission failure (HTTP 401/403 or PGRST301/42501). Drives the
   *  SyncBanner tappable sign-in link. Reset to false on the next successful
   *  remote call. Initialized false (no fault on startup). */
  isUnauthenticated: boolean
}

// Module-scope state — initialised to the "no fault" steady state (D-04 invisible).
let state: SyncStateShape = { unsyncedCount: 0, conflictDates: [], isUnauthenticated: false }

// Module-scope subscriber Set — each entry is a zero-argument notify callback.
const subscribers = new Set<() => void>()

/** Read the current sync state (no re-render triggered). */
export function getSyncState(): SyncStateShape {
  return state
}

/**
 * Write new sync state and notify all subscribers.
 *
 * Called by SyncEngine.runCycle() at the end of each cycle with fresh values.
 * Subscribers (SyncBanner) call getSyncState() inside their notify callback
 * to pull the latest value.
 */
export function setSyncState(next: SyncStateShape): void {
  state = next
  subscribers.forEach((cb) => cb())
}

/**
 * Subscribe to sync-state changes.
 *
 * @param cb  Zero-argument callback fired whenever setSyncState() is called.
 * @returns   Unsubscribe function — call it inside useEffect cleanup.
 *
 * Usage in SyncBanner:
 *   useEffect(() => {
 *     const unsub = subscribe(() => setState(getSyncState()))
 *     return unsub
 *   }, [])
 */
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}
