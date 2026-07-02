'use client'

import { useEffect, useState, useTransition } from 'react'
import { getRepository } from '@/lib/repository-provider'
import type { Habit } from '@/lib/types'

export default function HabitManagement() {
  const [habits, setHabits] = useState<Habit[] | null>(null)
  const [completionCounts, setCompletionCounts] = useState<Record<string, number>>({})
  const [, startTransition] = useTransition()

  // New-habit form state (D-08)
  const [name, setName] = useState('')
  const [shortName, setShortName] = useState('')
  const [shortNameEdited, setShortNameEdited] = useState(false)

  // Per-row editable draft state
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({})
  const [shortNameDrafts, setShortNameDrafts] = useState<Record<string, string>>({})

  // Archive confirm state (D-01)
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null)

  const reload = async () => {
    const repo = getRepository()
    const all = await repo.list<Habit>('habits', { includeDeleted: true })
    all.sort((a, b) => a.sort_order - b.sort_order)
    setHabits(all)

    // Fetch completion counts for each habit in parallel
    const counts: Record<string, number> = {}
    const results = await Promise.all(all.map(h => repo.listHabitCompletions(h.id)))
    for (let i = 0; i < all.length; i++) {
      counts[all[i].id] = results[i].length
    }
    setCompletionCounts(counts)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await reload()
      if (cancelled) return
    })()
    return () => { cancelled = true }
  }, [])

  const liveHabits = habits?.filter(h => h.deleted_at == null) ?? []
  const archivedHabits = habits?.filter(h => h.deleted_at != null) ?? []

  // ── New-habit form (D-08) ──

  const addNewHabit = () => {
    const n = name.trim()
    if (!n) return
    const s = shortName.trim() || [...n].slice(0, 2).join('')
    startTransition(async () => {
      await getRepository().addHabit(n, s)
      await reload()
      setName('')
      setShortName('')
      setShortNameEdited(false)
    })
  }

  // ── Per-row rename ──

  const commitRename = (habitId: string, originalName: string) => {
    const draft = nameDrafts[habitId]
    if (draft === undefined) return
    const trimmed = draft.trim()
    if (!trimmed || trimmed === originalName) {
      setNameDrafts(prev => { const n = { ...prev }; delete n[habitId]; return n })
      return
    }
    startTransition(async () => {
      await getRepository().renameHabit(habitId, trimmed)
      setNameDrafts(prev => { const n = { ...prev }; delete n[habitId]; return n })
      await reload()
    })
  }

  const commitShortName = (habitId: string, originalShortName: string) => {
    const draft = shortNameDrafts[habitId]
    if (draft === undefined) return
    const trimmed = draft.trim()
    if (!trimmed || trimmed === originalShortName) {
      setShortNameDrafts(prev => { const n = { ...prev }; delete n[habitId]; return n })
      return
    }
    startTransition(async () => {
      await getRepository().updateHabitShortName(habitId, trimmed)
      setShortNameDrafts(prev => { const n = { ...prev }; delete n[habitId]; return n })
      await reload()
    })
  }

  // ── Reorder (optimistic + confirm) ──

  const moveHabit = (habitId: string, direction: 'up' | 'down') => {
    if (!habits) return
    const idx = liveHabits.findIndex(h => h.id === habitId)
    if (idx === -1) return
    if (direction === 'up' && idx === 0) return
    if (direction === 'down' && idx === liveHabits.length - 1) return

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    const current = liveHabits[idx]
    const swap = liveHabits[swapIdx]

    const currentFullIdx = habits.findIndex(h => h.id === current.id)
    const swapFullIdx = habits.findIndex(h => h.id === swap.id)

    // Optimistic swap of sort_order values
    const updated = habits.map(h => ({ ...h }))
    const tempSortOrder = updated[currentFullIdx].sort_order
    updated[currentFullIdx].sort_order = updated[swapFullIdx].sort_order
    updated[swapFullIdx].sort_order = tempSortOrder
    updated.sort((a, b) => a.sort_order - b.sort_order)
    setHabits(updated)

    startTransition(async () => {
      await getRepository().reorderHabits(habitId, direction)
      await reload()
    })
  }

  // ── Archive (D-01) ──

  const archiveHabit = (habitId: string) => {
    startTransition(async () => {
      await getRepository().archiveHabit(habitId)
      setConfirmArchiveId(null)
      await reload()
    })
  }

  // ── Restore (D-02) ──

  const restoreHabit = (habitId: string) => {
    startTransition(async () => {
      await getRepository().restoreHabit(habitId)
      await reload()
    })
  }

  if (habits === null) {
    return <p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* ── New-habit form (D-08) ── */}
      <div style={{
        display: 'flex', gap: '12px', padding: '8px 0 12px 0',
        borderBottom: '1px solid var(--border)', alignItems: 'center',
      }}>
        <input
          value={name}
          onChange={e => {
            const value = e.target.value
            setName(value)
            if (!shortNameEdited) {
              setShortName([...value].slice(0, 2).join(''))
            }
          }}
          onKeyDown={e => e.key === 'Enter' && addNewHabit()}
          placeholder="习惯名称"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '17px', color: 'var(--foreground)' }}
        />
        <input
          value={shortName}
          onChange={e => {
            setShortNameEdited(true)
            setShortName(e.target.value)
          }}
          onKeyDown={e => e.key === 'Enter' && addNewHabit()}
          placeholder="简称"
          maxLength={4}
          style={{ width: '60px', background: 'transparent', border: 'none', outline: 'none', fontSize: '17px', color: 'var(--foreground)', textAlign: 'center' }}
        />
        <button
          onClick={addNewHabit}
          style={{ padding: '4px 12px', background: 'none', color: 'var(--accent)', border: 'none', fontSize: '15px', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          + 添加习惯
        </button>
      </div>

      {/* ── Live habit rows (D-07, D-01) ── */}
      {liveHabits.map((habit, idx) => (
        <div key={habit.id} style={{
          display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0',
        }}>
          {/* Reorder up/down */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flexShrink: 0 }}>
            <button
              onClick={() => moveHabit(habit.id, 'up')}
              disabled={idx === 0}
              style={{ background: 'none', border: 'none', color: idx === 0 ? 'var(--border)' : 'var(--muted)', cursor: idx === 0 ? 'default' : 'pointer', fontSize: '12px', padding: 0, lineHeight: 1 }}
              aria-label="上移"
            >
              ▲
            </button>
            <button
              onClick={() => moveHabit(habit.id, 'down')}
              disabled={idx === liveHabits.length - 1}
              style={{ background: 'none', border: 'none', color: idx === liveHabits.length - 1 ? 'var(--border)' : 'var(--muted)', cursor: idx === liveHabits.length - 1 ? 'default' : 'pointer', fontSize: '12px', padding: 0, lineHeight: 1 }}
              aria-label="下移"
            >
              ▼
            </button>
          </div>

          {/* Inline editable name */}
          <input
            value={nameDrafts[habit.id] !== undefined ? nameDrafts[habit.id] : habit.name}
            onChange={e => setNameDrafts(prev => ({ ...prev, [habit.id]: e.target.value }))}
            onBlur={() => commitRename(habit.id, habit.name)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur()
              }
            }}
            style={{ flex: 1, background: 'transparent', border: 'none', borderBottom: '1px solid transparent', outline: 'none', fontSize: '17px', color: 'var(--foreground)' }}
          />

          {/* Inline editable short_name */}
          <input
            value={shortNameDrafts[habit.id] !== undefined ? shortNameDrafts[habit.id] : habit.short_name}
            onChange={e => setShortNameDrafts(prev => ({ ...prev, [habit.id]: e.target.value }))}
            onBlur={() => commitShortName(habit.id, habit.short_name)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur()
              }
            }}
            maxLength={4}
            style={{ width: '48px', background: 'transparent', border: 'none', borderBottom: '1px solid transparent', outline: 'none', fontSize: '17px', color: 'var(--foreground)', textAlign: 'center' }}
          />

          {/* Archive (D-01) — confirm step when habit has completion history */}
          {confirmArchiveId === habit.id ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>确定存档?</span>
              <button
                onClick={() => archiveHabit(habit.id)}
                style={{ padding: '2px 8px', background: 'none', color: '#d96060', border: '1px solid #d96060', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}
              >
                确定
              </button>
              <button
                onClick={() => setConfirmArchiveId(null)}
                style={{ padding: '2px 8px', background: 'none', color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                if (completionCounts[habit.id] > 0) {
                  setConfirmArchiveId(habit.id)
                } else {
                  archiveHabit(habit.id)
                }
              }}
              style={{ padding: '4px 8px', background: 'none', color: 'var(--muted)', border: 'none', fontSize: '13px', cursor: 'pointer', flexShrink: 0 }}
            >
              存档
            </button>
          )}
        </div>
      ))}

      {/* ── Archived section (D-02) ── */}
      {archivedHabits.length > 0 && (
        <div>
          <h2 style={{ fontSize: '13px', color: 'var(--muted)', fontWeight: 400, marginBottom: '12px' }}>
            已存档
          </h2>
          {archivedHabits.map(habit => (
            <div key={habit.id} style={{
              display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0',
            }}>
              <span style={{ flex: 1, fontSize: '17px', color: 'var(--muted)' }}>
                {habit.name}
              </span>
              <button
                onClick={() => restoreHabit(habit.id)}
                style={{ padding: '4px 8px', background: 'none', color: 'var(--accent)', border: 'none', fontSize: '13px', cursor: 'pointer', flexShrink: 0 }}
              >
                恢复
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
