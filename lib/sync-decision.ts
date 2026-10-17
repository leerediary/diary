/**
 * Pure LWW sync decision function. No I/O, no DB access, no async work.
 *
 * ISO-8601 string comparison is lexically correct for the stored format
 * (YYYY-MM-DDTHH:MM:SS.sssZ) — lexical order matches chronological order.
 */

export enum SyncAction {
  APPLY = 'APPLY',
  APPLY_TOMBSTONE = 'APPLY_TOMBSTONE',
  JOURNAL_CONFLICT = 'JOURNAL_CONFLICT',
  SKIP = 'SKIP',
}

/** Minimal sync-relevant row shape shared by all entities. */
export type SyncRow = { id: string; updated_at: string; deleted_at: string | null }

/** Extended row shape for journal entries. */
type JournalRow = SyncRow & { date: string; content: string }

/**
 * Per-row LWW sync decision.
 *
 * LWW rule: pulled.updated_at >= local.updated_at → pulled wins (ties → pulled).
 * Server-clock authority: if the server's value is at least as recent as the local
 * value, the server is authoritative.
 *
 * Journal conflict exception (SYNC-04): if entity === 'journal_entries' AND pulled
 * would win AND local has unpushed content (isInOutbox) AND both sides are live
 * AND contents differ → return JOURNAL_CONFLICT (never silently overwrite local
 * journal content).
 *
 * @param local       Current local row (null if this is a new row from remote).
 * @param pulled      Row received from remote.list().
 * @param entity      Entity type — drives the journal-conflict path.
 * @param isInOutbox  Whether an outbox entry exists for this (entity, id) pair
 *                    (looked up by the engine before calling; keeps this fn pure).
 */
export function decideSyncAction(
  local: SyncRow | null,
  pulled: SyncRow,
  entity: string,
  isInOutbox: boolean,
): SyncAction {
  // Case 1: row doesn't exist locally → always apply (new row from remote).
  if (local === null) {
    return pulled.deleted_at ? SyncAction.APPLY_TOMBSTONE : SyncAction.APPLY
  }

  // Case 2: pulled is strictly older than local → local wins; skip.
  if (local.updated_at > pulled.updated_at) {
    return SyncAction.SKIP
  }

  // Case 3 / 4: pulled.updated_at >= local.updated_at (pulled wins — covers ties too).
  // Server-clock authority: ties go to the server-authoritative value (D-01).

  // Journal conflict exception: detect concurrent conflicting edits before applying LWW.
  // Only triggers when:
  //   - entity is journal_entries
  //   - local has unpushed edits in the outbox (isInOutbox)
  //   - neither side is a tombstone (both have live content)
  //   - the contents actually differ (identical content is not a conflict)
  if (
    entity === 'journal_entries' &&
    isInOutbox &&
    !pulled.deleted_at &&
    !local.deleted_at &&
    (local as JournalRow).content !== (pulled as JournalRow).content
  ) {
    return SyncAction.JOURNAL_CONFLICT
  }

  // Standard LWW: pulled wins.
  return pulled.deleted_at ? SyncAction.APPLY_TOMBSTONE : SyncAction.APPLY
}
