'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { getRepository } from '@/lib/repository-provider'
import { getTodayStr, getDayOffsetHours, dayKey } from '@/lib/today'
import { buildPomodoroChartData, type ChartPoint } from '@/lib/pomodoro-chart-data'
import type { Habit, LongTermTask, PomodoroSession } from '@/lib/types'
import TaskSelector from '../../components/TaskSelector'

// Two timer modes share the entire focus/break/summary machinery — they differ
// only in the duration range the picker offers. 番茄 = 20..30 min, 圣女果
// (cherry tomato) = 7..15 min. The ranges don't overlap, so a session's mode is
// derived at read time from duration_sec (< 16 min → 圣女果), no schema field.
type TimerMode = 'tomato' | 'cherry'
interface ModeRange {
  min: number
  max: number
  default: number
  storageKey: string  // per-mode localStorage key so each mode remembers its own pick
  label: string
}
const MODE_RANGES: Record<TimerMode, ModeRange> = {
  tomato: { min: 20, max: 30, default: 25, storageKey: 'pomodoro_duration_min', label: '番茄' },        // Phase 12 D-19
  cherry: { min: 7, max: 15, default: 10, storageKey: 'pomodoro_cherry_duration_min', label: '圣女果' },
}
const DEFAULT_DURATION_MIN = MODE_RANGES.tomato.default  // initial render mode is 番茄
// Classification threshold: 圣女果 tops out at 15 min, 番茄 starts at 20 — 16 min
// sits cleanly in the gap. Anything shorter is a 圣女果.
const CHERRY_MAX_SEC = 16 * 60
const isCherrySession = (s: PomodoroSession): boolean => s.duration_sec < CHERRY_MAX_SEC
const BREAK_KEY = 'pomodoro_break_duration_sec' // localStorage key (Claude's-Discretion)
const DEFAULT_BREAK_SEC = 5 * 60                // 5 minutes default
const DRAFT_NOTES_KEY = 'pomodoro_draft_notes' // localStorage key (Phase 11 D-12)

// Wheel geometry — touch idle drag-to-pick
const WHEEL_ROW_HEIGHT = 60             // px per row in the value column (was 44; bumped for visual breathing at center scale)
const WHEEL_BOX_OPEN = 250              // expanded box height — half-height 125 lets 2nd neighbor (visual pos 125 under R=180/22°) sit right at the edge, giving the "中心 + 上下 1.5 行" iOS-picker feel
const WHEEL_BOX_IDLE = 76               // collapsed box height (only center value)
const WHEEL_BOX_WIDTH = 90              // box width fits "20"–"30" at base font + scale
const WHEEL_BASE_FONT = 32              // base font; center row scaled up via transform
const WHEEL_CENTER_SCALE = 2            // 32 × 2 = 64px visual center digit
const WHEEL_SCALE_FALLOFF = 60          // px distance from center where scale returns to 1 (== ROW_HEIGHT for clean 1-row falloff)
const WHEEL_OPACITY_FALLOFF = 150       // px distance where opacity hits 0 — past the new box half-height so 2nd neighbor (linear dist 120) still has opacity 0.2 (faded but visible)
const WHEEL_RUBBER_BAND = 0.3           // multiplier on out-of-range overshoot
const WHEEL_SETTLE_MS = 350             // touchend → snap+collapse animation
const WHEEL_SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)'
// Perspective compensation — gives iOS-wheel-style spread near center + compression at edges.
// Each row's linear distance from box center maps to an angle (linearDist / ROW_HEIGHT × angle/row),
// then visual position = RADIUS × sin(angle). Per-row translateY compensates the diff.
// Angle clamped to ±π/2 so sin never folds back.
const WHEEL_PERSPECTIVE_RADIUS = 180     // larger → more spread near center, more compression far
const WHEEL_PERSPECTIVE_ANGLE_PER_ROW = (22 * Math.PI) / 180 // 22°/row → ~+7px spread on 1st neighbor

function computeSinceDate(today: string, days: number): string {
  const [y, m, d] = today.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() - days + 1)
  const yy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function formatMmss(sec: number): string {
  const m = Math.floor(sec / 60).toString().padStart(2, '0')
  const s = (sec % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}


function formatHistoryDate(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return '今天'
  const [y, m, d] = todayStr.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() - 1)
  const yesterday = t.toISOString().slice(0, 10)
  if (dateStr === yesterday) return '昨天'
  return dateStr.slice(5) // 'MM-DD'
}


function parseSelectorValue(value: string): { habitId: string | null; taskId: string | null } {
  if (value.startsWith('habit:')) return { habitId: value.slice('habit:'.length), taskId: null }
  if (value.startsWith('task:')) return { habitId: null, taskId: value.slice('task:'.length) }
  return { habitId: null, taskId: null }
}

export default function PomodoroPage() {
  const [phase, setPhase] = useState<'idle' | 'running' | 'summary' | 'break-idle' | 'break-running'>('idle')
  const [mode, setMode] = useState<TimerMode>('tomato')
  const [remaining, setRemaining] = useState(DEFAULT_DURATION_MIN * 60)
  const [durationMin, setDurationMin] = useState(DEFAULT_DURATION_MIN)
  // Snapshot of duration captured at 开始 press time. tick() reads this — never the live state.
  // (D-23: running session uses the duration as it was at start; localStorage changes mid-session only affect the NEXT session.)
  const runningDurationSecRef = useRef(DEFAULT_DURATION_MIN * 60)
  const [selectedHabitId, setSelectedHabitId] = useState<string | null>(null)
  const [modalHabitId, setModalHabitId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [modalTaskId, setModalTaskId] = useState<string | null>(null)
  // Phase 14 D-11: task-completion checkbox state. Reset to false on each new session.
  const [taskCompleted, setTaskCompleted] = useState(false)
  const [draftNotes, setDraftNotes] = useState<string[]>([])
  const [draftInput, setDraftInput] = useState('')
  const [breakSec, setBreakSec] = useState(DEFAULT_BREAK_SEC)
  // Phase 12 D-05: which note indices are flagged "distribute to linked habit".
  const [draftShared, setDraftShared] = useState<boolean[]>([])
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  // Phase 21: gate the wheel behind useEffect — SSR prerender has no window, so the
  // first render must match static HTML (stepper). After mount we flip touch-capable
  // devices (iPhone PWA, native shell, iPad, touchscreens) to the drag wheel; mouse
  // devices keep the −/+ stepper. Was native-shell-only (Phase 12); broadened to all
  // touch devices so the open-source PWA gets the wheel too.
  const [useWheel, setUseWheel] = useState(false)
  const [sessions, setSessions] = useState<PomodoroSession[] | null>(null)
  const [habits, setHabits] = useState<Habit[] | null>(null)
  const [tasks, setTasks] = useState<LongTermTask[] | null>(null)
  const [rangeDays, setRangeDays] = useState<7 | 30 | 90>(30)
  const [showDurationPicker, setShowDurationPicker] = useState(false)
  const [isWheelOpen, setIsWheelOpen] = useState(false)
  // Continuous drag offset (px) during touchmove. Reset to 0 when not dragging.
  // Used with baseTranslateY (derived from durationMin) to get the column's actual translateY.
  const [dragOffset, setDragOffset] = useState(0)
  // True during the touchend → settle animation so the column transform transitions smoothly.
  // Also keeps the distance-based opacity formula active during the 350ms snap so the
  // target row stays visible all the way to box center (fixes the "value disappears
  // then reappears" bug — without this, opacity flips to durationMin-based the instant
  // isWheelOpen=false, blanking out the snap target until commit fires).
  const [isSnapping, setIsSnapping] = useState(false)
  // Gates CSS transitions on the column transform and per-row opacity/scale.
  // True only during the active touchmove window — during drag we want pixel-perfect
  // finger tracking with zero transition lag; for all other moments (idle, open, snap)
  // transitions are enabled so state changes interpolate smoothly.
  const [isDragging, setIsDragging] = useState(false)
  const [tab, setTab] = useState<'timer' | 'stats'>('timer')

  const startedAtRef = useRef<number | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const submittingRef = useRef(false)
  const dragStartYRef = useRef<number | null>(null)
  const dragStartDurationRef = useRef<number>(DEFAULT_DURATION_MIN)

  // Active mode's duration range — drives the picker bounds, wheel geometry, and
  // stepper clamps. Recomputed each render from `mode`; handlers/effects read it
  // at call time (after this line has run), so no TDZ issue.
  const range = MODE_RANGES[mode]

  // ── Data load on mount ──
  useEffect(() => {
    let cancelled = false
      ; (async () => {
        const sinceDate = computeSinceDate(getTodayStr(), 90)
        const [hs, ss, ts] = await Promise.all([
          getRepository().listHabits(),
          getRepository().listPomodoroSessions(sinceDate),
          getRepository().listAllTasks(),
        ])
        if (!cancelled) {
          setHabits(hs)
          setSessions(ss)
          setTasks(ts)
        }
      })()
    return () => { cancelled = true }
  }, [])

  // Phase 21: resolve touch-capability after mount so the first render (which
  // matches the static-export HTML) always shows the stepper, then upgrade touch
  // devices to the wheel. pointer:coarse is true on phones/tablets/touchscreens,
  // false on mouse-driven desktops — the natural dividing line for a drag wheel.
  useEffect(() => {
    setUseWheel(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches,
    )
  }, [])

  // ── Load break duration from localStorage on mount ──
  useEffect(() => {
    try {
      const v = localStorage.getItem(BREAK_KEY)
      const n = v ? parseInt(v, 10) : NaN
      if (!isNaN(n) && n >= 60 && n <= 3600) {
        setBreakSec(n)
      }
    } catch { /* ignore localStorage unavailable */ }
  }, [])

  // ── Load duration from localStorage on mount (Phase 12 D-19) ──
  // Initial mode is 番茄, so restore the 番茄 duration. Switching to 圣女果 later
  // loads its own stored pick via switchMode().
  useEffect(() => {
    const r = MODE_RANGES.tomato
    try {
      const v = localStorage.getItem(r.storageKey)
      const n = v ? parseInt(v, 10) : NaN
      if (!isNaN(n) && n >= r.min && n <= r.max) {
        setDurationMin(n)
        setRemaining(n * 60)
        runningDurationSecRef.current = n * 60
      }
    } catch { /* ignore */ }
  }, [])

  // ── Load draft notes from localStorage on mount (D-12) ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_NOTES_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.every((s: unknown) => typeof s === 'string')) {
          setDraftNotes(parsed)
        }
      }
    } catch { /* ignore localStorage unavailable or corrupted data */ }
  }, [])

  // ── Persist draft notes to localStorage on every change (D-12) ──
  useEffect(() => {
    try {
      if (draftNotes.length > 0) {
        localStorage.setItem(DRAFT_NOTES_KEY, JSON.stringify(draftNotes))
      } else {
        localStorage.removeItem(DRAFT_NOTES_KEY)
      }
    } catch { /* ignore */ }
  }, [draftNotes])

  // Phase 12 D-05: sync draftShared when entering summary or when habit/notes change
  useEffect(() => {
    if (phase !== 'summary') return
    setDraftShared(prev => {
      const next: boolean[] = []
      for (let i = 0; i < draftNotes.length; i++) {
        if (i < prev.length) {
          next.push(modalHabitId != null ? prev[i] : false)
        } else {
          next.push(modalHabitId != null)
        }
      }
      return next
    })
  }, [phase, modalHabitId])

  // ── Timer tick ──
  const tick = useCallback(() => {
    const startedAt = startedAtRef.current
    if (startedAt == null) return
    const elapsed = Math.floor((Date.now() - startedAt) / 1000)
    const r = Math.max(0, runningDurationSecRef.current - elapsed)
    setRemaining(r)
    if (r === 0) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
      startedAtRef.current = null
      // Snap modal habit/task ids to the pre-start selection (D-06 phase 2, D-09)
      setModalHabitId(selectedHabitId)
      setModalTaskId(selectedTaskId)
      setPhase('summary')
    }
  }, [selectedHabitId, selectedTaskId])

  // ── Break tick ──
  const breakTick = useCallback(() => {
    const startedAt = startedAtRef.current
    if (startedAt == null) return
    const elapsed = Math.floor((Date.now() - startedAt) / 1000)
    const r = Math.max(0, breakSec - elapsed)
    setRemaining(r)
    if (r === 0) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
      startedAtRef.current = null
      setPhase('idle')
      setRemaining(durationMin * 60)
      setSelectedHabitId(null)
      setSelectedTaskId(null)
    }
  }, [breakSec])

  // ── Visibility change handler (Pitfall 2) ──
  useEffect(() => {
    function onVis() {
      if (document.visibilityState !== 'visible') return
      if (phase === 'running') tick()
      else if (phase === 'break-running') breakTick()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [phase, tick, breakTick])

  // ── Cleanup interval on unmount ──
  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  function startFocus() {
    runningDurationSecRef.current = durationMin * 60  // D-23 snapshot
    startedAtRef.current = Date.now()
    setRemaining(durationMin * 60)
    setPhase('running')
    setShowDurationPicker(false)
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(tick, 500)
  }

  function startBreak() {
    startedAtRef.current = Date.now()
    setRemaining(breakSec)
    setPhase('break-running')
    if (intervalRef.current) clearInterval(intervalRef.current)
    intervalRef.current = setInterval(breakTick, 500)
  }

  function persistBreak(sec: number) {
    try { localStorage.setItem(BREAK_KEY, String(sec)) } catch { /* ignore */ }
  }

  function persistDuration(min: number) {
    try { localStorage.setItem(range.storageKey, String(min)) } catch { /* ignore */ }
  }

  // Switch between 番茄 / 圣女果. Only allowed while idle (mid-session/break the
  // range must stay put). Loads the target mode's remembered duration (or its
  // default) and resets the display clock to it.
  function switchMode(next: TimerMode) {
    if (phase !== 'idle' || next === mode) return
    const r = MODE_RANGES[next]
    let dur = r.default
    try {
      const v = localStorage.getItem(r.storageKey)
      const n = v ? parseInt(v, 10) : NaN
      if (!isNaN(n) && n >= r.min && n <= r.max) dur = n
    } catch { /* ignore */ }
    setMode(next)
    setDurationMin(dur)
    setRemaining(dur * 60)
    runningDurationSecRef.current = dur * 60
  }

  function handleTimerTouchStart(e: React.TouchEvent) {
    if (!useWheel || phase !== 'idle') return
    dragStartYRef.current = e.touches[0].clientY
    dragStartDurationRef.current = durationMin
    setIsWheelOpen(true)
    setIsSnapping(false)
    setIsDragging(true) // turn off transitions for raw finger tracking
    setDragOffset(0)
  }
  function handleTimerTouchMove(e: React.TouchEvent) {
    if (!useWheel || phase !== 'idle') return
    if (dragStartYRef.current === null) return
    const dy = e.touches[0].clientY - dragStartYRef.current
    const startIndex = dragStartDurationRef.current - range.min
    const valueCount = range.max - range.min + 1
    // Valid dy range (within [MIN, MAX] bounds, no rubber band):
    //   dy positive → finger down → column shifts down → lower values reach center
    //   dy reaches MIN value: dy = startIndex * ROW (positive)
    //   dy reaches MAX value: dy = -((valueCount-1) - startIndex) * ROW (negative)
    const maxValidDy = startIndex * WHEEL_ROW_HEIGHT
    const minValidDy = -((valueCount - 1) - startIndex) * WHEEL_ROW_HEIGHT
    // Rubber band 0.3 outside valid range
    let effectiveDy = dy
    if (dy > maxValidDy) effectiveDy = maxValidDy + (dy - maxValidDy) * WHEEL_RUBBER_BAND
    else if (dy < minValidDy) effectiveDy = minValidDy + (dy - minValidDy) * WHEEL_RUBBER_BAND
    setDragOffset(effectiveDy)
  }
  function handleTimerTouchEnd() {
    if (dragStartYRef.current === null) return
    dragStartYRef.current = null
    // Compute snapped index from RAW (clamped) dy, not the rubber-band effective offset.
    // dragOffset may include rubber band but we want the snap target inside [MIN, MAX].
    const startIndex = dragStartDurationRef.current - range.min
    const valueCount = range.max - range.min + 1
    const rawIndexShift = Math.round(-dragOffset / WHEEL_ROW_HEIGHT)
    const targetIndex = Math.max(0, Math.min(valueCount - 1, startIndex + rawIndexShift))
    const snappedDuration = range.min + targetIndex
    // Use CLAMPED shift (not rawIndexShift) for the snap-target dragOffset, so
    // when rubber band overshoots the boundary the column animates back to the
    // boundary value, not past it. actualShift = targetIndex - startIndex.
    const actualShift = targetIndex - startIndex
    // Animate column translateY to snap target and collapse box, then commit.
    // After 350ms: durationMin updates AND dragOffset resets — both changes cancel
    // (baseTranslateY shifts by +actualShift*ROW, dragOffset goes from -actualShift*ROW to 0),
    // so translateY stays equal across the commit boundary — no visual jump.
    // isSnapping stays true through the 350ms so opacity formula uses distance-based
    // (keeps the snap target visible at center, instead of flashing 0 then 1 at commit).
    setIsDragging(false) // re-enable CSS transitions
    setIsSnapping(true)
    setDragOffset(-actualShift * WHEEL_ROW_HEIGHT) // animates to snap target
    setIsWheelOpen(false)                          // animates box height 220→76
    window.setTimeout(() => {
      setDurationMin(snappedDuration)
      persistDuration(snappedDuration)
      setRemaining(snappedDuration * 60)
      setDragOffset(0)
      setIsSnapping(false)
    }, WHEEL_SETTLE_MS)
  }

  async function onSubmitSession() {
    if (submittingRef.current) return
    submittingRef.current = true
    try {
      const today = getTodayStr()

      // 1. Flush any in-flight inline edit (Task 12-02-T4 — edit not committed until blur).
      // Phase 12 R3: pair liveNotes with liveShared so index deletions propagate
      // to the distribution flags before shared_indices are built.
      let liveNotes = draftNotes
      let liveShared = draftShared
      if (editingIdx != null) {
        const v = editingValue.trim()
        if (v === '') {
          liveNotes = liveNotes.filter((_, i) => i !== editingIdx)
          liveShared = liveShared.filter((_, i) => i !== editingIdx)
        } else {
          liveNotes = liveNotes.map((n, i) => i === editingIdx ? v : n)
          // liveShared unchanged — editing text preserves the distribution flag
        }
        setEditingIdx(null)
        setEditingValue('')
      }

      // 2. Auto-flush any unsent text in the add-input field (preserves Phase 11 Q2 behavior).
      const flushed = draftInput.trim() !== ''
        ? [...liveNotes, draftInput.trim()]
        : liveNotes
      const notes: string[] = flushed

      // 3. D-06: build shared_indices from liveShared (post-edit-flush).
      const habitId = modalHabitId
      const taskId = modalTaskId
      const sharedAligned = (() => {
        if (flushed.length > liveShared.length) {
          const extra = Array.from({ length: flushed.length - liveShared.length }, () => habitId != null)
          return [...liveShared, ...extra]
        }
        if (flushed.length < liveShared.length) {
          return liveShared.slice(0, flushed.length)
        }
        return liveShared
      })()
      const shared_indices: number[] = habitId != null
        ? sharedAligned.flatMap((on, i) => on ? [i] : [])
        : []

      // 4. Persist the session with both notes and shared_indices.
      const session: PomodoroSession = {
        id: crypto.randomUUID(),
        started_at: new Date(Date.now() - runningDurationSecRef.current * 1000).toISOString(),
        duration_sec: runningDurationSecRef.current,
        notes,
        habit_id: habitId,
        shared_indices,
        task_id: taskId,
        marked_task_complete: taskId != null && taskCompleted,
        updated_at: '',
        deleted_at: null,
      }
      await getRepository().savePomodoroSession(session)

      // Phase 14 D-13: if a task is linked AND the user ticked 完成了吗, mark the task complete.
      // Skipped silently if taskCompleted is false or the task has since been deleted from local state.
      if (taskId != null && taskCompleted) {
        await getRepository().completeTask(taskId)
      }

      // 5. D-07 / D-06 integration — habit auto-complete + filtered note append.
      if (habitId != null) {
        const day = await getRepository().getDay(today)
        const existing = day.completions.find(c => c.habit_id === habitId)
        // Only the SHARED subset goes to the habit note (D-06 filter).
        const sharedNotes = notes.filter((_, i) => shared_indices.includes(i))
        if (!existing) {
          await getRepository().setHabitCompleted(habitId, today, true)
          if (sharedNotes.length > 0) {
            await getRepository().saveHabitNote(habitId, today, sharedNotes.join('\n'))
          }
        } else {
          if (sharedNotes.length > 0) {
            const prior = existing.note ?? ''
            const combined = prior === '' ? sharedNotes.join('\n') : prior + '\n' + sharedNotes.join('\n')
            await getRepository().saveHabitNote(habitId, today, combined)
          }
        }
      }

      // 6. Re-load sessions for the chart + history section.
      const sinceDate = computeSinceDate(today, 90)
      const fresh = await getRepository().listPomodoroSessions(sinceDate)
      setSessions(fresh)

      // 7. Clear drafts + transition (D-13 Phase 11 + D-03 Phase 12).
      setDraftNotes([])
      setDraftInput('')
      setDraftShared([])
      setPhase('break-idle')
      setRemaining(breakSec)
      setSelectedHabitId(null)
      setSelectedTaskId(null)
      setModalHabitId(null)
      setModalTaskId(null)
      setTaskCompleted(false)
    } finally {
      submittingRef.current = false
    }
  }

  const chartData: ChartPoint[] = useMemo(
    () => buildPomodoroChartData(sessions ?? [], rangeDays, getTodayStr(), getDayOffsetHours()),
    [sessions, rangeDays],
  )

  // Phase 11 D-14/D-15: 番茄历史 — last 7 days grouped by calendar day.
  const historyGroups = useMemo(() => {
    if (!sessions || sessions.length === 0) return []
    const today = getTodayStr()
    const offset = getDayOffsetHours()
    const since = computeSinceDate(today, 7) // 7 days ago (inclusive)
    // Filter to last 7 days (by local logical day, DAY_OFFSET-aware)
    const recent = sessions.filter(s => s.started_at && dayKey(s.started_at, offset) >= since)
    // Group by local logical day
    const map = new Map<string, PomodoroSession[]>()
    for (const s of recent) {
      if (!s.started_at) continue
      const d = dayKey(s.started_at, offset)
      const list = map.get(d) ?? []
      list.push(s)
      map.set(d, list)
    }
    // Convert to array, sort within each group by started_at descending (D-15)
    const groups: { date: string; sessions: PomodoroSession[] }[] = []
    for (const [date, list] of map) {
      list.sort((a, b) => b.started_at.localeCompare(a.started_at))
      groups.push({ date, sessions: list })
    }
    // Sort groups by date descending (today first)
    groups.sort((a, b) => b.date.localeCompare(a.date))
    return groups
  }, [sessions])

  return (
    <div>
      <style>{`@keyframes pomodoroSheetSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }`}</style>
      {/* Page shell */}
      <div style={{ marginBottom: '32px' }}>
        <Link href="/" style={{ color: 'var(--accent)', fontSize: '15px', textDecoration: 'none' }}>← 返回</Link>
      </div>
      {/* Title + tab switcher on the same row — title left, switcher right.
          Page padding (px-6 + max-w-2xl) is handled by app/layout.tsx <main>. */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '32px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>番茄</h1>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
          <button
            onClick={() => setTab('timer')}
            style={{
              padding: '0 16px',
              height: '32px',
              background: tab === 'timer' ? '#1d1d1f' : 'transparent',
              color: tab === 'timer' ? '#ffffff' : 'var(--muted)',
              border: 'none',
              fontSize: '14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              lineHeight: 1,
            }}
          >
            计时
          </button>
          <button
            onClick={() => setTab('stats')}
            style={{
              padding: '0 16px',
              height: '32px',
              background: tab === 'stats' ? '#1d1d1f' : 'transparent',
              color: tab === 'stats' ? '#ffffff' : 'var(--muted)',
              border: 'none',
              borderLeft: '1px solid var(--border)',
              fontSize: '14px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              lineHeight: 1,
            }}
          >
            统计
          </button>
        </div>
      </div>

      {tab === 'timer' && (
        <>
          {/* Timer + Break section */}
          <div style={{ textAlign: 'center', marginBottom: '48px' }}>
            {/* Mode toggle — 番茄 (20–30 min) / 圣女果 (7–15 min). Idle only:
                switching mid-session would invalidate the running duration. */}
            {phase === 'idle' && (
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '32px' }}>
                <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: '8px', overflow: 'hidden' }}>
                  {(['tomato', 'cherry'] as TimerMode[]).map((m, i) => (
                    <button
                      key={m}
                      onClick={() => switchMode(m)}
                      aria-pressed={mode === m}
                      style={{
                        padding: '0 20px',
                        height: '32px',
                        background: mode === m ? '#1d1d1f' : 'transparent',
                        color: mode === m ? '#ffffff' : 'var(--muted)',
                        border: 'none',
                        borderLeft: i === 0 ? 'none' : '1px solid var(--border)',
                        fontSize: '14px',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        lineHeight: 1,
                      }}
                    >
                      {MODE_RANGES[m].label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {phase === 'idle' ? (
              useWheel ? (
                <div
                  onTouchStart={handleTimerTouchStart}
                  onTouchMove={handleTimerTouchMove}
                  onTouchEnd={handleTimerTouchEnd}
                  onTouchCancel={handleTimerTouchEnd}
                  aria-label={`时长 ${durationMin} 分钟，长按上下拖动调整`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '100%',
                    marginBottom: '4px',
                    fontWeight: 300,
                    color: 'var(--foreground)',
                    fontFamily: 'inherit',
                    lineHeight: 1,
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                  }}
                >
                  {/* MinutesBox — compact pill (76px) idle, expands to 220px on touchstart.
                      Manual touch + continuous translateY (no inertia, no native CSS scroll).
                      User design 2026-05-29: finger fully controls — touchstart=open,
                      touchend=snap to nearest + collapse. Rubber band on bounds. */}
                  <div
                    style={{
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: `${WHEEL_BOX_WIDTH}px`,
                      height: `${isWheelOpen ? WHEEL_BOX_OPEN : WHEEL_BOX_IDLE}px`,
                      background: 'var(--card)',
                      border: '1px solid var(--border)',
                      borderRadius: '14px',
                      overflow: 'hidden',
                      transition: `height ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}`,
                    }}
                  >
                    {/* Value column — all 11 rows rendered once, transformed as a unit.
                        baseTranslateY centers durationMin's row at box center.
                        dragOffset is the live finger delta during drag, or the snap-target
                        during settle. Together: continuous, jank-free positioning. */}
                    {(() => {
                      const valueCount = range.max - range.min + 1
                      const values = Array.from({ length: valueCount }, (_, i) => range.min + i)
                      const totalColumnHeight = valueCount * WHEEL_ROW_HEIGHT
                      const visibleHeight = isWheelOpen ? WHEEL_BOX_OPEN : WHEEL_BOX_IDLE
                      const boxCenter = visibleHeight / 2
                      const centerIndex = Math.floor(valueCount / 2)
                      const indexOfDuration = durationMin - range.min
                      const baseTranslateY = (centerIndex - indexOfDuration) * WHEEL_ROW_HEIGHT
                      const translateY = baseTranslateY + dragOffset
                      // Column's natural top inside box (flex-centered): (visibleHeight - totalColumnHeight) / 2
                      const columnNaturalTop = (visibleHeight - totalColumnHeight) / 2
                      // CSS transitions ON whenever NOT actively dragging. Touchstart→touchmove
                      // window: transitions off, finger tracks 1:1. Touchend onward: transitions on,
                      // column transform animates to snap target, opacities settle smoothly.
                      const rowTransition = isDragging
                        ? 'none'
                        : `opacity ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}, transform ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}`
                      const columnTransition = isDragging
                        ? 'none'
                        : `transform ${WHEEL_SETTLE_MS}ms ${WHEEL_SPRING}`
                      return (
                        <div
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            transform: `translateY(${translateY}px)`,
                            transition: columnTransition,
                            willChange: 'transform',
                          }}
                        >
                          {values.map((v, i) => {
                            const rowCenterInColumn = i * WHEEL_ROW_HEIGHT + WHEEL_ROW_HEIGHT / 2
                            const rowScreenY = columnNaturalTop + translateY + rowCenterInColumn
                            // Linear (signed) distance from box center — used for drag-math invariants:
                            // scale falloff, opacity falloff, AND as input to perspective compensation.
                            const linearDistSigned = rowScreenY - boxCenter
                            const dist = Math.abs(linearDistSigned)
                            // Perspective: project linear distance onto a sin curve so visually,
                            // center spreads out (R*sin(angle) > linearDist near 0) and edges
                            // compress (R*sin clamped at R as angle→π/2). Compensation = visual − linear.
                            const angle = Math.max(
                              -Math.PI / 2,
                              Math.min(
                                Math.PI / 2,
                                (linearDistSigned / WHEEL_ROW_HEIGHT) * WHEEL_PERSPECTIVE_ANGLE_PER_ROW,
                              ),
                            )
                            const visualDistSigned = WHEEL_PERSPECTIVE_RADIUS * Math.sin(angle)
                            const perspectiveY = visualDistSigned - linearDistSigned
                            const scaleT = Math.max(0, 1 - dist / WHEEL_SCALE_FALLOFF)
                            const scale = 1 + (WHEEL_CENTER_SCALE - 1) * scaleT
                            const isCurrentCenter = i === indexOfDuration
                            // Distance-based opacity is active during the WHOLE drag+snap window
                            // (isWheelOpen || isSnapping). After the snap settles, formula switches
                            // to "only durationMin's row visible" — which by construction matches
                            // the dist-based value (target at center→1, others past edge→0).
                            const opacity = (isWheelOpen || isSnapping)
                              ? Math.max(0, 1 - dist / WHEEL_OPACITY_FALLOFF)
                              : isCurrentCenter ? 1 : 0
                            return (
                              <div
                                key={v}
                                style={{
                                  height: `${WHEEL_ROW_HEIGHT}px`,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: `${WHEEL_BASE_FONT}px`,
                                  fontWeight: 300,
                                  lineHeight: 1,
                                  color: 'var(--foreground)',
                                  opacity,
                                  // translateY first, then scale — moves the row to its perspective
                                  // position, then scales around its (translated) center.
                                  transform: `translateY(${perspectiveY}px) scale(${scale})`,
                                  transformOrigin: 'center center',
                                  transition: rowTransition,
                                  minWidth: '60px',
                                  fontVariantNumeric: 'tabular-nums',
                                }}
                              >
                                {String(v).padStart(2, '0')}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })()}
                  </div>

                  {/* Colon + seconds — outside the box, vertically centered by parent flex. */}
                  <span style={{ padding: '0 11.5px 0 5px', fontSize: '64px', lineHeight: 1, userSelect: 'none', WebkitUserSelect: 'none', fontVariantNumeric: 'tabular-nums' }}>:</span>
                  <span style={{ fontSize: '64px', lineHeight: 1, userSelect: 'none', WebkitUserSelect: 'none', fontVariantNumeric: 'tabular-nums' }}>00</span>
                </div>
              ) : (
                <button
                  onClick={() => setShowDurationPicker(v => !v)}
                  aria-label={`时长 ${durationMin} 分钟，点击调整`}
                  style={{
                    display: 'block',
                    width: '100%',
                    fontSize: '64px',
                    fontWeight: 300,
                    color: 'var(--foreground)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    marginBottom: '4px',
                    fontFamily: 'inherit',
                    lineHeight: 1.2,
                  }}
                >
                  {formatMmss(durationMin * 60)}
                </button>
              )
            ) : (
              useWheel ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', marginBottom: '24px', fontWeight: 300, color: 'var(--foreground)', lineHeight: 1, userSelect: 'none', WebkitUserSelect: 'none' }}>
                  <div style={{ width: `${WHEEL_BOX_WIDTH}px`, height: `${WHEEL_BOX_IDLE}px`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '64px', fontVariantNumeric: 'tabular-nums' }}>
                    {String(Math.floor(remaining / 60)).padStart(2, '0')}
                  </div>
                  <span style={{ padding: '0 11.5px 0 5px', fontSize: '64px', lineHeight: 1, userSelect: 'none', WebkitUserSelect: 'none', fontVariantNumeric: 'tabular-nums' }}>:</span>
                  <span style={{ fontSize: '64px', lineHeight: 1, userSelect: 'none', WebkitUserSelect: 'none', fontVariantNumeric: 'tabular-nums' }}>
                    {String(remaining % 60).padStart(2, '0')}
                  </span>
                </div>
              ) : (
                <div style={{ fontSize: '64px', fontWeight: 300, color: 'var(--foreground)', marginBottom: '24px' }}>
                  {formatMmss(remaining)}
                </div>
              )
            )}

            {/* Phase 12: duration picker — shown on tap during idle (non-touch devices; touch uses the drag wheel) */}
            {phase === 'idle' && !useWheel && showDurationPicker && (
              <div style={{
                margin: '0 auto 24px',
                padding: '20px',
                maxWidth: '280px',
                background: 'var(--card)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
                  <button
                    onClick={() => {
                      const next = Math.max(range.min, durationMin - 1)
                      setDurationMin(next)
                      persistDuration(next)
                      setRemaining(next * 60)
                    }}
                    disabled={durationMin <= range.min}
                    aria-label="减少时长"
                    style={{
                      width: '28px', height: '28px', borderRadius: '50%',
                      background: 'var(--card)', color: 'var(--accent)',
                      border: 'none', cursor: durationMin <= range.min ? 'default' : 'pointer',
                      fontSize: '17px', fontWeight: 600, lineHeight: 1,
                      opacity: durationMin <= range.min ? 0.4 : 1,
                      fontFamily: 'inherit',
                    }}
                  >−</button>
                  <span style={{ fontSize: '17px', fontWeight: 600, color: 'var(--foreground)', minWidth: '48px', textAlign: 'center' }}>
                    {durationMin}
                  </span>
                  <button
                    onClick={() => {
                      const next = Math.min(range.max, durationMin + 1)
                      setDurationMin(next)
                      persistDuration(next)
                      setRemaining(next * 60)
                    }}
                    disabled={durationMin >= range.max}
                    aria-label="增加时长"
                    style={{
                      width: '28px', height: '28px', borderRadius: '50%',
                      background: 'var(--card)', color: 'var(--accent)',
                      border: 'none', cursor: durationMin >= range.max ? 'default' : 'pointer',
                      fontSize: '17px', fontWeight: 600, lineHeight: 1,
                      opacity: durationMin >= range.max ? 0.4 : 1,
                      fontFamily: 'inherit',
                    }}
                  >+</button>
                </div>
              </div>
            )}

            {phase === 'idle' && (
              <div>
                <div style={{ width: 'min(280px, 100%)', margin: '32px auto 16px' }}>
                  <TaskSelector
                    value={selectedHabitId ? `habit:${selectedHabitId}` : selectedTaskId ? `task:${selectedTaskId}` : ''}
                    onChange={(v) => {
                      const parsed = parseSelectorValue(v)
                      setSelectedHabitId(parsed.habitId)
                      setSelectedTaskId(parsed.taskId)
                    }}
                    habits={habits ?? []}
                    tasks={tasks ?? []}
                  />
                </div>

                <div>
                  <button
                    onClick={startFocus}
                    style={{
                      color: 'var(--accent)',
                      fontWeight: 600,
                      fontSize: '17px',
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                    }}
                  >
                    开始
                  </button>
                </div>
              </div>
            )}

            {phase === 'running' && (
              <div style={{ color: 'var(--muted)', fontSize: '15px' }}>专注中…</div>
            )}

            {phase === 'break-idle' && (
              <div>
                <div style={{ marginBottom: '16px', fontSize: '15px', color: 'var(--muted)' }}>
                  短休:
                  <input
                    type="number"
                    value={breakSec / 60}
                    min={1}
                    max={60}
                    onChange={(e) => {
                      const mins = parseInt(e.target.value, 10)
                      if (isNaN(mins) || mins < 1) return
                      const sec = Math.max(60, Math.min(3600, mins * 60))
                      setBreakSec(sec)
                      persistBreak(sec)
                    }}
                    style={{
                      fontSize: '16px',
                      width: '48px',
                      padding: '4px 8px',
                      marginLeft: '8px',
                      border: '1px solid var(--border)',
                      borderRadius: 0,
                      background: 'var(--background)',
                      color: 'var(--foreground)',
                      textAlign: 'center',
                    }}
                  />
                  <span style={{ marginLeft: '4px' }}>分钟</span>
                </div>
                <button
                  onClick={startBreak}
                  style={{
                    color: 'var(--accent)',
                    fontWeight: 600,
                    fontSize: '17px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  开始休息
                </button>
              </div>
            )}

            {phase === 'break-running' && (
              <div style={{ color: 'var(--muted)', fontSize: '15px' }}>休息中…</div>
            )}
          </div>

          {/* Phase 11: Inline notes — visible during idle and running (D-08) */}
          {(phase === 'idle' || phase === 'running') && (
            <div style={{ marginBottom: '32px' }}>
              {/* Notes list above input (D-09) */}
              {draftNotes.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                  {draftNotes.map((note, idx) => {
                    const isEditing = editingIdx === idx
                    return (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {/* Tap to edit inline — notes stay editable the whole pomodoro,
                          not only in the summary panel (finished a task mid-pomodoro,
                          edit this note then start a new one). */}
                      {isEditing ? (
                        <input
                          type="text"
                          autoFocus
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onBlur={() => {
                            const v = editingValue.trim()
                            setDraftNotes(prev => {
                              if (v === '') return prev.filter((_, i) => i !== idx)
                              return prev.map((n, i) => i === idx ? v : n)
                            })
                            if (v === '') {
                              setDraftShared(prev => prev.filter((_, i) => i !== idx))
                            }
                            setEditingIdx(null)
                            setEditingValue('')
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur() }
                            else if (e.key === 'Escape') { setEditingIdx(null); setEditingValue('') }
                          }}
                          style={{
                            flex: 1,
                            background: 'transparent',
                            border: 'none',
                            borderBottom: '1px solid var(--border)',
                            padding: '8px 0',
                            fontSize: '16px',
                            color: 'var(--foreground)',
                            outline: 'none',
                            fontFamily: 'inherit',
                          }}
                        />
                      ) : (
                        <span
                          onClick={() => { setEditingIdx(idx); setEditingValue(note) }}
                          style={{
                            flex: 1,
                            fontSize: '15px',
                            color: 'var(--foreground)',
                            padding: '8px 0',
                            borderBottom: '1px solid var(--border)',
                            lineHeight: 1.47,
                            cursor: 'text',
                          }}
                        >
                          {note}
                        </span>
                      )}
                      <button
                        onClick={() => {
                          setDraftNotes(prev => prev.filter((_, i) => i !== idx))
                          setDraftShared(prev => prev.filter((_, i) => i !== idx))
                          if (editingIdx === idx) { setEditingIdx(null); setEditingValue('') }
                        }}
                        aria-label="删除这条笔记"
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--muted)',
                          opacity: 0.5,
                          cursor: 'pointer',
                          fontSize: '16px',
                          lineHeight: 1,
                          padding: '0 4px',
                          fontFamily: 'inherit',
                        }}
                      >
                        ×
                      </button>
                    </div>
                    )
                  })}
                </div>
              )}

              {/* Single-line input + 添加 button (D-08, D-09) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="text"
                  value={draftInput}
                  onChange={(e) => setDraftInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const text = draftInput.trim()
                      if (text !== '') {
                        setDraftNotes(prev => [...prev, text])
                        setDraftInput('')
                      }
                    }
                  }}
                  placeholder="记录一下这个番茄做了什么…"
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--border)',
                    padding: '8px 0',
                    fontSize: '16px',
                    color: 'var(--foreground)',
                    outline: 'none',
                    fontFamily: 'inherit',
                  }}
                />
                <button
                  onClick={() => {
                    const text = draftInput.trim()
                    if (text !== '') {
                      setDraftNotes(prev => [...prev, text])
                      setDraftInput('')
                    }
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                    fontSize: '14px',
                    padding: '4px 0',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  添加
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Phase 12 D-01/D-03: iOS-style bottom sheet replacing summary modal */}
      {phase === 'summary' && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: 0,
            width: 'min(480px, 100%)',
            zIndex: 100,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pomodoro-sheet-title"
            style={{
              background: 'var(--background)',
              borderTopLeftRadius: '12px',
              borderTopRightRadius: '12px',
              height: 'min(85vh, 600px)',
              display: 'flex',
              flexDirection: 'column',
              animation: 'pomodoroSheetSlideUp 280ms ease-out',
            }}
          >
            {/* Drag-handle visual (D-01 Specifics: ~36×5, #c0c0c5, 8px from top, centered) */}
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '8px', paddingBottom: '8px' }}>
              <div style={{ width: '36px', height: '5px', background: '#c0c0c5', borderRadius: '2.5px' }} />
            </div>

            {/* Title */}
            <h2 id="pomodoro-sheet-title" style={{ fontSize: '24px', fontWeight: 700, padding: '0 24px', marginBottom: '24px' }}>
              {range.label}完成
            </h2>

            {/* Scrollable body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 24px' }}>
              {/* Phase 14 D-11: task-completion row, top of sheet, shown only for task-linked sessions */}
              {modalTaskId != null && (() => {
                const linkedTask = (tasks ?? []).find(t => t.id === modalTaskId)
                return (
                  <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <input
                      type="checkbox"
                      checked={taskCompleted}
                      onChange={(e) => setTaskCompleted(e.target.checked)}
                      aria-label="完成了吗"
                      style={{
                        width: '18px',
                        height: '18px',
                        accentColor: '#0066cc',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ flex: 1, fontSize: '15px', color: 'var(--foreground)' }}>
                      {linkedTask?.name ?? '已删除的任务'}
                    </span>
                    <span style={{ fontSize: '13px', color: 'var(--muted)' }}>完成了吗？</span>
                  </div>
                )
              })()}
              {/* Phase 14: modal selector — hidden for task-linked sessions; habit-only grouped select otherwise */}
              {modalTaskId == null && (
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ display: 'block', fontSize: '13px', color: 'var(--muted)', marginBottom: '8px' }}>
                    关联
                  </label>
                  <TaskSelector
                    value={modalHabitId ? `habit:${modalHabitId}` : ''}
                    onChange={(v) => {
                      const parsed = parseSelectorValue(v)
                      setModalHabitId(parsed.habitId)
                      // modalTaskId intentionally NOT settable here (Phase 14 D-11 frozen)
                    }}
                    habits={habits ?? []}
                    tasks={[]}
                    width="100%"
                  />
                </div>
              )}

              {/* Phase 12 D-02/D-05: editable notes list with per-line distribution checkbox */}
              <div style={{ marginBottom: '24px' }}>
                <label style={{ display: 'block', fontSize: '13px', color: 'var(--muted)', marginBottom: '8px' }}>
                  笔记
                </label>

                {draftNotes.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
                    {draftNotes.map((note, idx) => {
                      const isEditing = editingIdx === idx
                      const isShared = draftShared[idx] ?? false
                      return (
                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {/* D-05: checkbox shown only when a habit is linked */}
                          {modalHabitId != null && (
                            <input
                              type="checkbox"
                              checked={isShared}
                              onChange={(e) => {
                                setDraftShared(prev => prev.map((v, i) => i === idx ? e.target.checked : v))
                              }}
                              title="分给关联习惯"
                              aria-label="分给关联习惯"
                              style={{
                                width: '18px',
                                height: '18px',
                                accentColor: '#0066cc',
                                cursor: 'pointer',
                                flexShrink: 0,
                              }}
                            />
                          )}

                          {/* Note text — tap to edit; turns into <input> while editing (D-02) */}
                          {isEditing ? (
                            <input
                              type="text"
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onBlur={() => {
                                const v = editingValue.trim()
                                setDraftNotes(prev => {
                                  if (v === '') {
                                    return prev.filter((_, i) => i !== idx)
                                  }
                                  return prev.map((n, i) => i === idx ? v : n)
                                })
                                if (v === '') {
                                  setDraftShared(prev => prev.filter((_, i) => i !== idx))
                                }
                                setEditingIdx(null)
                                setEditingValue('')
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur() }
                                else if (e.key === 'Escape') { setEditingIdx(null); setEditingValue('') }
                              }}
                              style={{
                                flex: 1,
                                background: 'transparent',
                                border: 'none',
                                borderBottom: '1px solid var(--border)',
                                padding: '8px 0',
                                fontSize: '16px',
                                color: 'var(--foreground)',
                                outline: 'none',
                                fontFamily: 'inherit',
                              }}
                            />
                          ) : (
                            <span
                              onClick={() => { setEditingIdx(idx); setEditingValue(note) }}
                              style={{
                                flex: 1,
                                fontSize: '15px',
                                color: 'var(--foreground)',
                                padding: '8px 0',
                                borderBottom: '1px solid var(--border)',
                                lineHeight: 1.47,
                                cursor: 'text',
                              }}
                            >
                              {note}
                            </span>
                          )}

                          {/* Delete × — same as inline notes */}
                          <button
                            onClick={() => {
                              setDraftNotes(prev => prev.filter((_, i) => i !== idx))
                              setDraftShared(prev => prev.filter((_, i) => i !== idx))
                              if (editingIdx === idx) { setEditingIdx(null); setEditingValue('') }
                            }}
                            aria-label="删除这条笔记"
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--muted)',
                              opacity: 0.5,
                              cursor: 'pointer',
                              fontSize: '16px',
                              lineHeight: 1,
                              padding: '0 4px',
                              fontFamily: 'inherit',
                            }}
                          >×</button>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Add input + 添加 button — same pattern as inline notes */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <input
                    type="text"
                    value={draftInput}
                    onChange={(e) => setDraftInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        const text = draftInput.trim()
                        if (text !== '') {
                          setDraftNotes(prev => [...prev, text])
                          setDraftShared(prev => [...prev, modalHabitId != null])
                          setDraftInput('')
                        }
                      }
                    }}
                    placeholder="添加一条笔记…"
                    style={{
                      flex: 1,
                      background: 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--border)',
                      padding: '8px 0',
                      fontSize: '16px',
                      color: 'var(--foreground)',
                      outline: 'none',
                      fontFamily: 'inherit',
                    }}
                  />
                  <button
                    onClick={() => {
                      const text = draftInput.trim()
                      if (text !== '') {
                        setDraftNotes(prev => [...prev, text])
                        setDraftShared(prev => [...prev, modalHabitId != null])
                        setDraftInput('')
                      }
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--accent)',
                      cursor: 'pointer',
                      fontSize: '14px',
                      padding: '4px 0',
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    添加
                  </button>
                </div>
              </div>
            </div>

            {/* Footer: 完成 button */}
            <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border)', textAlign: 'right' }}>
              <button
                onClick={onSubmitSession}
                style={{
                  color: 'var(--accent)',
                  fontWeight: 600,
                  fontSize: '17px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chart Section */}
      {tab === 'stats' && sessions !== null && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '32px' }}>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginBottom: '16px' }}>
            <button
              onClick={() => setRangeDays(7)}
              style={{
                color: rangeDays === 7 ? 'var(--accent)' : 'var(--muted)',
                fontWeight: rangeDays === 7 ? 600 : 400,
                fontSize: '15px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              7天
            </button>
            <button
              onClick={() => setRangeDays(30)}
              style={{
                color: rangeDays === 30 ? 'var(--accent)' : 'var(--muted)',
                fontWeight: rangeDays === 30 ? 600 : 400,
                fontSize: '15px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              30天
            </button>
            <button
              onClick={() => setRangeDays(90)}
              style={{
                color: rangeDays === 90 ? 'var(--accent)' : 'var(--muted)',
                fontWeight: rangeDays === 90 ? 600 : 400,
                fontSize: '15px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              90天
            </button>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 32, bottom: 0, left: 32 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12, fill: 'var(--muted)' }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="left"
                orientation="left"
                allowDecimals={false}
                tick={{ fontSize: 12, fill: 'var(--muted)' }}
                tickLine={false}
                axisLine={false}
                width={24}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                allowDecimals={false}
                tick={{ fontSize: 12, fill: 'var(--muted)' }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <Tooltip
                contentStyle={{ background: 'var(--background)', border: '1px solid var(--border)', fontSize: 13 }}
                labelStyle={{ color: 'var(--muted)' }}
              />
              <Bar yAxisId="left" dataKey="daily" fill="#0066cc" opacity={0.7} radius={[2, 2, 0, 0]} />
              <Line yAxisId="right" dataKey="cumul" type="monotone" stroke="#0066cc" strokeWidth={1.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
          {sessions.length === 0 && (
            <p style={{ color: 'var(--muted)', fontSize: '15px', textAlign: 'center', marginTop: '16px' }}>
              还没有番茄记录
            </p>
          )}

          {/* Phase 11 D-14: 番茄历史 — last 7 days grouped by day */}
          {sessions.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: '32px', marginTop: '32px' }}>
              <div style={{ maxWidth: '360px', margin: '0 auto' }}>
                <h2 style={{
                  fontSize: '20px',
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  marginBottom: '24px',
                }}>
                  番茄历史
                </h2>
                {historyGroups.length === 0 ? (
                  <p style={{ color: 'var(--muted)', fontSize: '15px' }}>
                    最近7天还没有番茄记录
                  </p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                    {historyGroups.map((group) => {
                      const today = getTodayStr()
                      return (
                        <div key={group.date}>
                          {/* Day header (D-15: 今天/昨天/MM-DD) */}
                          <h3 style={{
                            fontSize: '15px',
                            fontWeight: 600,
                            color: 'var(--muted)',
                            marginBottom: '12px',
                          }}>
                            {formatHistoryDate(group.date, today)}
                          </h3>
                          {/* Session rows (D-16: HH:MM · habit name · notes) */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {group.sessions.map((s) => {
                              const time = new Date(s.started_at).toLocaleTimeString('zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit',
                                hour12: false,
                                // No timeZone option → device-local (was hardcoded Asia/Shanghai).
                              })
                              const habitName = s.habit_id
                                ? (habits ?? []).find(h => h.id === s.habit_id)?.name ?? null
                                : null
                              return (
                                <div key={s.id} style={{ fontSize: '15px', color: 'var(--foreground)', lineHeight: 1.47 }}>
                                  <span style={{ fontWeight: 500 }}>{time}</span>
                                  {isCherrySession(s) && (
                                    <span style={{ color: 'var(--muted)' }}>
                                      {' · '}{MODE_RANGES.cherry.label}
                                    </span>
                                  )}
                                  {habitName && (
                                    <span style={{ color: 'var(--muted)' }}>
                                      {' · '}{habitName}
                                    </span>
                                  )}
                                  {s.notes.length > 0 && (
                                    <div style={{ marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                      {s.notes.map((n, i) => (
                                        <div key={i} style={{ color: 'var(--muted)', fontSize: '14px' }}>
                                          {n}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
