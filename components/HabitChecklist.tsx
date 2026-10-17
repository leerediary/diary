'use client'

import { useState, useTransition, useRef, useEffect } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { Habit } from '@/lib/types'

interface Props {
  habits: Habit[]
  completedIds: string[]
  initialNotes: Record<string, string>
  date: string
  readonly?: boolean
}

export default function HabitChecklist({ habits, completedIds, initialNotes, date, readonly }: Props) {
  const [completed, setCompleted] = useState<Set<string>>(new Set(completedIds))
  const [notes, setNotes] = useState<Record<string, string>>(initialNotes)
  const [savingNotes, setSavingNotes] = useState<Set<string>>(new Set())
  const [pending, startTransition] = useTransition()
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // After Enter inserts a line, focus that new input once it mounts.
  const pendingFocus = useRef<{ habitId: string; index: number } | null>(null)
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map())

  // Focus the line Enter just inserted, AFTER it has mounted. Done in an
  // effect — never inside a ref callback: an inline ref callback re-runs
  // every render and a focus() side effect there can wedge the renderer.
  useEffect(() => {
    const pf = pendingFocus.current
    if (!pf) return
    const el = inputRefs.current.get(`${pf.habitId}__${pf.index}`)
    if (el) {
      el.focus()
      pendingFocus.current = null
    }
  }, [notes])

  // Notes are stored as one string per habit; each independent line is
  // separated by "\n". An empty note still shows a single editable line.
  const linesOf = (habitId: string) => (notes[habitId] ?? '').split('\n')

  const setLine = (habitId: string, index: number, value: string) => {
    const lines = linesOf(habitId)
    lines[index] = value
    updateNote(habitId, lines.join('\n'))
  }

  const addLine = (habitId: string) => {
    updateNote(habitId, [...linesOf(habitId), ''].join('\n'))
  }

  // Enter shortcut: insert a fresh independent line right after the current
  // one and focus it (same effect as the "添加笔记" button, inline).
  const insertLineAfter = (habitId: string, index: number) => {
    const lines = linesOf(habitId)
    lines.splice(index + 1, 0, '')
    pendingFocus.current = { habitId, index: index + 1 }
    updateNote(habitId, lines.join('\n'))
  }

  const removeLine = (habitId: string, index: number) => {
    const lines = linesOf(habitId)
    lines.splice(index, 1)
    updateNote(habitId, (lines.length ? lines : ['']).join('\n'))
  }

  const toggle = (habitId: string) => {
    const isDone = completed.has(habitId)
    setCompleted(prev => {
      const next = new Set(prev)
      if (isDone) {
        next.delete(habitId)
      } else {
        next.add(habitId)
      }
      return next
    })
    if (isDone) {
      // Unchecking: clear pending note save and local note
      if (timers.current[habitId]) clearTimeout(timers.current[habitId])
      setNotes(prev => { const n = { ...prev }; delete n[habitId]; return n })
    }
    startTransition(async () => {
      // isDone = state BEFORE toggle; setHabitCompleted takes the desired state.
      await getRepository().setHabitCompleted(habitId, date, !isDone)
    })
  }

  const updateNote = (habitId: string, note: string) => {
    setNotes(prev => ({ ...prev, [habitId]: note }))
    setSavingNotes(prev => new Set(prev).add(habitId))
    if (timers.current[habitId]) clearTimeout(timers.current[habitId])
    timers.current[habitId] = setTimeout(async () => {
      await getRepository().saveHabitNote(habitId, date, note)
      setSavingNotes(prev => {
        const next = new Set(prev)
        next.delete(habitId)
        return next
      })
    }, 600)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', opacity: pending ? 0.85 : 1 }}>
      {habits.map(habit => {
        const done = completed.has(habit.id)
        const saving = savingNotes.has(habit.id)
        return (
          <div key={habit.id} style={{ padding: '4px 0' }}>
            <div
              onClick={() => !readonly && toggle(habit.id)}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: readonly ? 'default' : 'pointer' }}
            >
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '22px',
                height: '22px',
                borderRadius: '50%',
                background: done ? 'var(--accent)' : 'transparent',
                border: done ? 'none' : '1.5px solid var(--border)',
                color: 'white',
                fontSize: '0.75em',
                fontWeight: 700,
                flexShrink: 0,
                opacity: done ? 1 : 0.6,
                transition: 'all 0.15s',
              }}>
                {done ? '✓' : ''}
              </span>
              <span style={{
                fontSize: '17px',
                color: done ? 'var(--muted)' : 'var(--foreground)',
                textDecoration: done ? 'line-through' : 'none',
              }}>
                {habit.name}
              </span>
            </div>
            {done && (() => {
              const allLines = linesOf(habit.id)
              // Read-only views (e.g. month) hide blank lines entirely.
              const lines = readonly ? allLines.filter(l => l.trim() !== '') : allLines
              if (readonly && lines.length === 0) return null
              return (
                <div style={{ marginLeft: '34px', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {lines.map((line, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <input
                        ref={el => {
                          const k = `${habit.id}__${idx}`
                          if (el) inputRefs.current.set(k, el)
                          else inputRefs.current.delete(k)
                        }}
                        value={line}
                        onChange={e => !readonly && setLine(habit.id, idx, e.target.value)}
                        onKeyDown={e => {
                          if (readonly) return
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            insertLineAfter(habit.id, idx)
                          }
                        }}
                        readOnly={readonly}
                        placeholder={readonly ? '' : '记录一下今天做了什么…'}
                        style={{
                          flex: 1,
                          background: 'transparent',
                          border: 'none',
                          borderBottom: '1px solid var(--border)',
                          padding: '8px 0',
                          fontSize: '16px',
                          color: 'var(--muted)',
                          outline: 'none',
                          fontFamily: 'inherit',
                        }}
                      />
                      {!readonly && allLines.length > 1 && (
                        <button
                          onClick={() => removeLine(habit.id, idx)}
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
                      )}
                    </div>
                  ))}
                  {!readonly && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => addLine(habit.id)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent)',
                          cursor: 'pointer',
                          fontSize: '14px',
                          padding: '4px 0',
                          fontFamily: 'inherit',
                          alignSelf: 'flex-start',
                        }}
                      >
                        + 添加笔记
                      </button>
                      {saving && (
                        <span style={{ fontSize: '13px', color: 'var(--muted)', opacity: 0.6 }}>…</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )
      })}
    </div>
  )
}
