/**
 * Table-driven unit matrix for decideSyncAction — all 17 edge-case rows from
 * 06-RESEARCH.md §edge_case_matrix. Each row has exactly one assertion.
 * Any failure exits non-zero (vitest default).
 */
import { describe, expect, it } from 'vitest'
import { decideSyncAction, SyncAction, type SyncRow } from '@/lib/sync-decision'

// ISO timestamps with clear lexical ordering: T1 < T2 < T3 < T_TIE = T same value
const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-06-01T00:00:00.000Z'
const T3 = '2099-01-01T00:00:00.000Z' // "far future" for clock-skew test
const T_TIE = '2026-03-15T12:00:00.000Z'

function live(updated_at: string): SyncRow {
  return { id: 'row-1', updated_at, deleted_at: null }
}
function tombstone(updated_at: string): SyncRow {
  return { id: 'row-1', updated_at, deleted_at: updated_at }
}
function journalLive(updated_at: string, content: string): SyncRow & { date: string; content: string } {
  return { id: 'row-1', updated_at, deleted_at: null, date: '2026-05-18', content }
}

// ── Matrix rows ──

type MatrixRow = {
  n: number
  name: string
  local: SyncRow | null
  pulled: SyncRow
  entity: string
  isInOutbox: boolean
  expected: SyncAction
}

const matrix: MatrixRow[] = [
  {
    n: 1,
    name: 'new row from remote (first sync) → APPLY',
    local: null,
    pulled: live(T2),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 2,
    name: 'new tombstone from remote (local=null) → APPLY_TOMBSTONE',
    local: null,
    pulled: tombstone(T2),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.APPLY_TOMBSTONE,
  },
  {
    n: 3,
    name: 'both changed — remote newer → APPLY',
    local: live(T1),
    pulled: live(T2),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 4,
    name: 'both changed — local newer → SKIP',
    local: live(T2),
    pulled: live(T1),
    entity: 'habits',
    isInOutbox: true,
    expected: SyncAction.SKIP,
  },
  {
    n: 5,
    name: 'tie (equal updated_at) — pulled wins → APPLY',
    local: live(T_TIE),
    pulled: live(T_TIE),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 6,
    name: 'delete vs edit — remote tombstone newer → APPLY_TOMBSTONE',
    local: live(T1),
    pulled: tombstone(T2),
    entity: 'long_term_tasks',
    isInOutbox: false,
    expected: SyncAction.APPLY_TOMBSTONE,
  },
  {
    n: 7,
    name: 'delete vs edit — local edit newer (local tombstone newer) → SKIP',
    local: tombstone(T2),
    pulled: live(T1),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.SKIP,
  },
  {
    n: 8,
    name: 'edit vs delete — local live newer than remote tombstone → SKIP',
    local: live(T2),
    pulled: tombstone(T1),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.SKIP,
  },
  {
    n: 9,
    name: 'edit vs delete — remote live newer than local tombstone → APPLY (legitimate un-delete)',
    local: tombstone(T1),
    pulled: live(T2),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 10,
    name: 'journal — remote newer, no local outbox entry → APPLY (standard LWW)',
    local: journalLive(T1, 'A'),
    pulled: journalLive(T2, 'B'),
    entity: 'journal_entries',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 11,
    name: 'journal — remote newer, in outbox, SAME content → APPLY (no conflict)',
    local: journalLive(T1, 'A'),
    pulled: journalLive(T2, 'A'),
    entity: 'journal_entries',
    isInOutbox: true,
    expected: SyncAction.APPLY,
  },
  {
    n: 12,
    name: 'journal — remote newer, in outbox, different content → JOURNAL_CONFLICT',
    local: journalLive(T1, 'local edit'),
    pulled: journalLive(T2, 'remote edit'),
    entity: 'journal_entries',
    isInOutbox: true,
    expected: SyncAction.JOURNAL_CONFLICT,
  },
  {
    n: 13,
    name: 'journal — tie, different content, local in outbox → JOURNAL_CONFLICT',
    local: journalLive(T_TIE, 'A'),
    pulled: journalLive(T_TIE, 'B'),
    entity: 'journal_entries',
    isInOutbox: true,
    expected: SyncAction.JOURNAL_CONFLICT,
  },
  {
    n: 14,
    name: 'clock skew — remote updated_at far future → APPLY (device clock irrelevant)',
    local: live(T2),
    pulled: live(T3),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 15,
    name: 'guard reject — push already applied server-side; pull returns newer → APPLY',
    // isInOutbox=false: push phase drained the outbox before this pull lookup
    local: live(T1),
    pulled: live(T2),
    entity: 'habits',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 16,
    name: 'first sync — all rows from remote, local=null → APPLY for live row',
    local: null,
    pulled: live(T2),
    entity: 'habit_completions',
    isInOutbox: false,
    expected: SyncAction.APPLY,
  },
  {
    n: 17,
    name: 'tombstone-vs-tombstone — remote tombstone newer → APPLY_TOMBSTONE',
    local: tombstone(T1),
    pulled: tombstone(T2),
    entity: 'long_term_tasks',
    isInOutbox: false,
    expected: SyncAction.APPLY_TOMBSTONE,
  },
]

describe('decideSyncAction — 17-row edge-case matrix', () => {
  for (const row of matrix) {
    it(`#${row.n} ${row.name}`, () => {
      expect(decideSyncAction(row.local, row.pulled, row.entity, row.isInOutbox)).toBe(row.expected)
    })
  }

  // Coverage guard: exactly 17 distinct matrix row numbers present — any
  // regression that removes a row (e.g., accidental dedup) hard-fails the suite.
  it('coverage guard: exactly 17 distinct matrix rows are asserted', () => {
    const rowNumbers = matrix.map((r) => r.n)
    const unique = new Set(rowNumbers)
    expect(unique.size).toBe(17)
    for (let i = 1; i <= 17; i++) {
      expect(unique.has(i), `matrix row #${i} is missing`).toBe(true)
    }
  })

  // Verify all four SyncAction members appear as expected values across the matrix.
  it('all four SyncAction members appear as expected values', () => {
    const actions = new Set(matrix.map((r) => r.expected))
    expect(actions.has(SyncAction.APPLY)).toBe(true)
    expect(actions.has(SyncAction.APPLY_TOMBSTONE)).toBe(true)
    expect(actions.has(SyncAction.JOURNAL_CONFLICT)).toBe(true)
    expect(actions.has(SyncAction.SKIP)).toBe(true)
  })
})

// Bonus: verify row 16's tombstone variant (APPLY_TOMBSTONE for first-sync tombstone row)
// covered separately from the main matrix to keep the matrix 17 rows exactly.
describe('decideSyncAction — first-sync tombstone (row 16 tombstone variant)', () => {
  it('first sync — local=null, pulled is tombstoned → APPLY_TOMBSTONE', () => {
    expect(decideSyncAction(null, tombstone(T2), 'habit_completions', false)).toBe(
      SyncAction.APPLY_TOMBSTONE,
    )
  })
})
