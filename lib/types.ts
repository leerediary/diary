// Sync-ready metadata shared by every entity.
// updated_at is set client-side on every write in Phase 1; server-clock
// (Supabase trigger) authority is introduced in Phase 2. deleted_at is the
// soft-delete tombstone — null means the row is live.
export interface SyncMeta {
  id: string // client-generated UUID (crypto.randomUUID) at insert time
  updated_at: string // ISO 8601
  deleted_at: string | null // ISO 8601 tombstone; null = live
}

export interface Habit extends SyncMeta {
  name: string
  short_name: string
  sort_order: number
}

// Natural key is (habit_id, date); `id` is sync plumbing, not the lookup key.
// D-09 / D-04: completed_at is NOT NULL — migration backfills all existing rows.
// Phase 17.1: client-authoritative "tap time" decoupled from server-clock updated_at.
export interface HabitCompletion extends SyncMeta {
  habit_id: string
  date: string
  note: string | null
  completed_at: string
}

// Unique key is `date`; `id` is sync plumbing.
export interface JournalEntry extends SyncMeta {
  date: string
  content: string
}

export interface LongTermTask extends SyncMeta {
  name: string
  category: string
  parent_id: string | null
  is_for_today: boolean
  delay_days: number
  completed: boolean
  completed_at: string | null
  created_at: string
  // YYYY-MM-DD of the last rollover that affected this task; null = never.
  // Drives idempotent date-anchored rollover (see Repository.rolloverTasks).
  last_rollover_date: string | null
}

export interface TaskNode extends LongTermTask {
  children: LongTermTask[]
  derivedCompleted?: boolean
}

// Natural key is (id). habit_id and task_id are nullable: null means no link.
// Phase 14: task_id added; mutually exclusive with habit_id (application invariant).
// Phase 14-04: marked_task_complete added; per-session record of "this session completed the task". Decoupled from task.completed.
// Only completed sessions are stored (D-03 — presence = completion; no `completed` boolean).
// Phase 11: notes is string[] — multi-note model replacing the old single note field.
// Phase 12: shared_indices records which note indices were distributed to the linked habit.
export interface PomodoroSession extends SyncMeta {
  started_at: string      // ISO 8601 — when the 25-min focus began
  duration_sec: number    // actual seconds of the completed session (always ~1500)
  notes: string[]         // free-text session notes (Phase 11 D-02); empty array = no notes
  habit_id: string | null // FK-like reference to habits.id; null = unlinked session
  shared_indices: number[]  // indices into notes[] that were distributed to the linked habit. Empty = none distributed (Phase 12 D-07).
  task_id: string | null  // FK-like reference to long_term_tasks.id; null = no task linked. INVARIANT: habit_id and task_id are mutually exclusive (at most one non-null per session) — enforced at application layer, not DB.
  marked_task_complete: boolean  // Phase 14-04: true only when the user ticked "完成了吗" in the completion sheet for THIS session. Decoupled from long_term_tasks.completed — uncompleting the task later does NOT clear this flag. INVARIANT: marked_task_complete === true requires task_id != null (application-layer, not DB).
}
