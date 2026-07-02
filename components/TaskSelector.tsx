'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Habit, LongTermTask } from '@/lib/types'

export interface TaskSelectorProps {
  value: string
  onChange: (value: string) => void
  habits: Habit[]
  tasks: LongTermTask[]
  disabled?: boolean
  width?: string | number
}

type Tab = 'habits' | 'today' | 'longTerm'

interface CategoryGroup {
  category: string
  parents: { task: LongTermTask; children: LongTermTask[] }[]
}

function buildLongTermByCategory(list: LongTermTask[]): CategoryGroup[] {
  const childrenOf = new Map<string, LongTermTask[]>()
  const parents: LongTermTask[] = []
  for (const t of list) {
    if (t.parent_id == null) {
      parents.push(t)
    } else {
      const kids = childrenOf.get(t.parent_id) ?? []
      kids.push(t)
      childrenOf.set(t.parent_id, kids)
    }
  }

  // Orphans: parent_id set but parent missing — treat as roots
  const parentIds = new Set(parents.map(p => p.id))
  for (const t of list) {
    if (t.parent_id != null && !parentIds.has(t.parent_id)) parents.push(t)
  }

  const groups = new Map<string, { task: LongTermTask; children: LongTermTask[] }[]>()
  for (const p of parents) {
    const cat = p.category || '未分类'
    const arr = groups.get(cat) ?? []
    arr.push({ task: p, children: childrenOf.get(p.id) ?? [] })
    groups.set(cat, arr)
  }

  return Array.from(groups.entries()).map(([category, parents]) => ({ category, parents }))
}

export default function TaskSelector({
  value,
  onChange,
  habits,
  tasks,
  disabled,
  width = 'min(280px, 100%)',
}: TaskSelectorProps) {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('habits')
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set())
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setMounted(true)
  }, [])

  function openPanel() {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const openAbove = spaceBelow < 360 && rect.top > 360

    setPanelStyle({
      position: 'fixed',
      left: rect.left,
      width: rect.width,
      zIndex: 9999,
      maxHeight: '360px',
      overflowY: 'auto',
      background: 'var(--background)',
      border: '1px solid var(--border)',
      borderRadius: 0,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top }
        : { top: rect.bottom }),
    })
    setSearchQuery('')
    setActiveTab('habits')
    setCollapsedCategories(new Set())

    // All parent tasks start collapsed
    const parentIds = tasks
      .filter(t => t.is_for_today === false && !t.completed && t.deleted_at == null && t.parent_id === null)
      .map(t => t.id)
    setCollapsedParents(new Set(parentIds))

    setOpen(true)
  }

  function closePanel() {
    setOpen(false)
  }

  // Outside-click handler
  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: PointerEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        closePanel()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  // Derived values
  const todayTasks = useMemo(
    () => tasks.filter(t => t.is_for_today === true && !t.completed && t.deleted_at == null),
    [tasks],
  )

  const longTermSource = useMemo(
    () => tasks.filter(t => t.is_for_today === false && !t.completed && t.deleted_at == null),
    [tasks],
  )

  const longTermGroups = useMemo(
    () => buildLongTermByCategory(longTermSource),
    [longTermSource],
  )

  // Selected value parsing for dimming and label
  const selectedHabitId = value.startsWith('habit:') ? value.slice(6) : null
  const selectedTaskId = value.startsWith('task:') ? value.slice(5) : null
  const habitsDimmed = selectedTaskId != null
  const tasksDimmed = selectedHabitId != null

  const displayLabel = useMemo(() => {
    if (selectedHabitId != null) {
      const habit = habits.find(h => h.id === selectedHabitId)
      return habit?.name ?? '不关联'
    }
    if (selectedTaskId != null) {
      const task = tasks.find(t => t.id === selectedTaskId)
      if (!task) return '不关联'
      if (task.parent_id != null) {
        const parent = tasks.find(t => t.id === task.parent_id)
        if (parent) return parent.name + ' · ' + task.name
      }
      return task.name
    }
    return '不关联'
  }, [value, habits, tasks, selectedHabitId, selectedTaskId])

  // Search state — scoped to active tab
  const q = searchQuery.trim().toLowerCase()
  const searching = q.length > 0
  const matches = (name: string) => name.toLowerCase().includes(q)

  function switchTab(next: Tab) {
    setActiveTab(next)
    setSearchQuery('')
  }

  function toggleCategory(cat: string) {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      return next
    })
  }

  function toggleParent(id: string) {
    setCollapsedParents(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Filtered lists for habits / today tabs
  const visibleHabits = searching ? habits.filter(h => matches(h.name)) : habits
  const visibleTodayTasks = searching ? todayTasks.filter(t => matches(t.name)) : todayTasks

  const itemStyle: React.CSSProperties = {
    padding: '8px 12px',
    fontSize: '15px',
    color: 'var(--foreground)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  }

  const categoryHeaderStyle: React.CSSProperties = {
    fontWeight: 600,
    fontSize: '13px',
    color: 'var(--muted)',
    padding: '8px 12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  }

  const tabButton = (tab: Tab, label: string, isFirst: boolean) => (
    <button
      key={tab}
      onClick={() => switchTab(tab)}
      style={{
        flex: 1,
        padding: '0 12px',
        height: '32px',
        background: activeTab === tab ? '#1d1d1f' : 'transparent',
        color: activeTab === tab ? '#ffffff' : 'var(--muted)',
        border: 'none',
        borderLeft: isFirst ? 'none' : '1px solid var(--border)',
        fontSize: '13px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  )

  return (
    <div style={{ width, position: 'relative' }}>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        onClick={() => (open ? closePanel() : openPanel())}
        style={{
          width,
          padding: '8px 12px',
          fontSize: '15px',
          border: '1px solid var(--border)',
          borderRadius: 0,
          background: 'var(--background)',
          color: 'var(--foreground)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          textAlign: 'left',
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayLabel}
        </span>
        <span style={{ color: 'var(--muted)' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {mounted && open && createPortal(
        <div ref={panelRef} style={panelStyle}>
          {/* "不关联" — always at top */}
          <div
            onClick={() => { onChange(''); closePanel() }}
            style={{ ...itemStyle, borderBottom: '1px solid var(--border)' }}
          >
            不关联
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)' }}>
            {tabButton('habits', '每日打卡', true)}
            {tabButton('today', '今日任务', false)}
            {tabButton('longTerm', '长期任务', false)}
          </div>

          {/* Search input */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索..."
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 12px',
              fontSize: '16px',
              border: 'none',
              borderBottom: '1px solid var(--border)',
              borderRadius: 0,
              background: 'var(--background)',
              color: 'var(--foreground)',
              outline: 'none',
            }}
          />

          {/* Tab content */}
          {activeTab === 'habits' && (
            <div style={habitsDimmed ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
              {visibleHabits.length === 0 ? (
                <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default' }}>
                  {searching ? '无匹配' : '暂无每日打卡'}
                </div>
              ) : visibleHabits.map(h => (
                <div
                  key={h.id}
                  onClick={() => { onChange('habit:' + h.id); closePanel() }}
                  style={itemStyle}
                >
                  {h.name}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'today' && (
            <div style={tasksDimmed ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
              {visibleTodayTasks.length === 0 ? (
                <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default' }}>
                  {searching ? '无匹配' : '暂无今日任务'}
                </div>
              ) : visibleTodayTasks.map(t => (
                <div
                  key={t.id}
                  onClick={() => { onChange('task:' + t.id); closePanel() }}
                  style={itemStyle}
                >
                  {t.name}
                </div>
              ))}
            </div>
          )}

          {activeTab === 'longTerm' && (
            <div style={tasksDimmed ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
              {(() => {
                // Filter groups → parents → children by search; drop empty
                const filtered = longTermGroups.map(g => {
                  const parents = g.parents.map(p => {
                    if (!searching) return { ...p, parentMatches: true }
                    const parentMatches = matches(p.task.name)
                    const matchedChildren = p.children.filter(c => matches(c.name))
                    if (parentMatches) {
                      return { task: p.task, children: p.children, parentMatches: true }
                    }
                    if (matchedChildren.length > 0) {
                      return { task: p.task, children: matchedChildren, parentMatches: false }
                    }
                    return null
                  }).filter((x): x is NonNullable<typeof x> => x != null)
                  return { category: g.category, parents }
                }).filter(g => g.parents.length > 0)

                if (filtered.length === 0) {
                  return (
                    <div style={{ ...itemStyle, color: 'var(--muted)', cursor: 'default' }}>
                      {searching ? '无匹配' : '暂无长期任务'}
                    </div>
                  )
                }

                return filtered.map(group => {
                  const catCollapsed = !searching && collapsedCategories.has(group.category)
                  return (
                    <div key={group.category}>
                      <div
                        onClick={() => !searching && toggleCategory(group.category)}
                        style={categoryHeaderStyle}
                      >
                        <span style={{ width: '12px', fontSize: '10px' }}>
                          {catCollapsed ? '▶' : '▼'}
                        </span>
                        {group.category}
                      </div>
                      {!catCollapsed && group.parents.map(p => {
                        const hasChildren = p.children.length > 0
                        const parentExpanded = searching || !collapsedParents.has(p.task.id)
                        const isContextOnly = searching && !p.parentMatches

                        return (
                          <div key={p.task.id}>
                            <div
                              onClick={() => {
                                if (isContextOnly) return
                                onChange('task:' + p.task.id)
                                closePanel()
                              }}
                              style={{
                                ...itemStyle,
                                paddingLeft: '24px',
                                ...(isContextOnly ? { pointerEvents: 'none', opacity: 0.6 } : {}),
                              }}
                            >
                              {hasChildren && (
                                <span
                                  onClick={(e) => {
                                    if (searching) return
                                    e.stopPropagation()
                                    toggleParent(p.task.id)
                                  }}
                                  style={{ width: '12px', fontSize: '10px', cursor: 'pointer', marginRight: '6px' }}
                                >
                                  {parentExpanded ? '▼' : '▶'}
                                </span>
                              )}
                              {!hasChildren && <span style={{ width: '18px' }} />}
                              {p.task.name}
                            </div>
                            {parentExpanded && p.children.map(child => (
                              <div
                                key={child.id}
                                onClick={() => { onChange('task:' + child.id); closePanel() }}
                                style={{ ...itemStyle, paddingLeft: '48px' }}
                              >
                                {child.name}
                              </div>
                            ))}
                          </div>
                        )
                      })}
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
