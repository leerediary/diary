'use client'

import { useState, useTransition } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { LongTermTask, TaskNode } from '@/lib/types'

function buildTree(tasks: LongTermTask[]): Map<string, TaskNode[]> {
  const nodeMap = new Map<string, TaskNode>()
  const categories = new Map<string, TaskNode[]>()

  for (const t of tasks) {
    if (!t.parent_id) {
      const node: TaskNode = { ...t, children: [] }
      nodeMap.set(t.id, node)
      if (!categories.has(t.category)) categories.set(t.category, [])
      categories.get(t.category)!.push(node)
    }
  }
  for (const t of tasks) {
    if (t.parent_id) {
      const parent = nodeMap.get(t.parent_id)
      if (parent) parent.children.push(t)
    }
  }
  for (const [, nodes] of categories) {
    for (const node of nodes) {
      if (node.children.length > 0) {
        node.derivedCompleted = node.children.every(c => c.completed)
      }
    }
  }
  return categories
}

interface RowProps {
  task: LongTermTask
  indent?: boolean
  onComplete: (id: string) => void
  onDelete: (id: string) => void
  onToggleToday: (task: LongTermTask) => void
}

function TaskRow({ task, indent, onComplete, onDelete, onToggleToday }: RowProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '12px',
      padding: indent ? '8px 0 8px 32px' : '12px 0',
      borderBottom: '1px solid var(--border)',
      opacity: task.completed ? 0.5 : 1,
    }}>
      <span
        onClick={() => !task.completed && onComplete(task.id)}
        title={task.completed ? '已完成' : '完成'}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: indent ? '14px' : '16px',
          height: indent ? '14px' : '16px',
          borderRadius: indent ? '50%' : '2px',
          border: task.completed ? 'none' : '1.5px solid var(--border)',
          background: task.completed ? 'var(--accent)' : 'transparent',
          color: 'white', fontSize: '0.65em', fontWeight: 700,
          cursor: task.completed ? 'default' : 'pointer', flexShrink: 0,
        }}
      >
        {task.completed ? '✓' : ''}
      </span>
      <span style={{
        flex: 1, fontSize: indent ? '15px' : '17px',
        color: task.completed ? 'var(--muted)' : 'var(--foreground)',
        textDecoration: task.completed ? 'line-through' : 'none',
      }}>
        {task.name}
      </span>
      {!task.completed && task.delay_days > 0 && (
        <span style={{ fontSize: '13px', color: '#d96060', flexShrink: 0 }}>
          拖{task.delay_days}天
        </span>
      )}
      {!task.completed && (
        <button
          onClick={() => onToggleToday(task)}
          style={{
            fontSize: '13px', padding: '4px 10px',
            border: `1px solid ${task.is_for_today ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: '2px', cursor: 'pointer',
            background: task.is_for_today ? 'var(--accent)' : 'transparent',
            color: task.is_for_today ? 'white' : 'var(--muted)',
            flexShrink: 0,
          }}
        >
          今天
        </button>
      )}
      {!task.completed && (
        <button
          onClick={() => onDelete(task.id)}
          style={{ fontSize: '17px', color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', flexShrink: 0, lineHeight: 1 }}
        >
          ×
        </button>
      )}
    </div>
  )
}

export default function TaskList({ tasks: initial }: { tasks: LongTermTask[] }) {
  const [tasks, setTasks] = useState(initial)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [, startTransition] = useTransition()

  const categories = buildTree(tasks)

  // Client-side post-mutation freshness (replaces the removed router.refresh()).
  const reload = async () => setTasks(await getRepository().listAllTasks())

  const toggleExpand = (id: string) =>
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const handleComplete = (taskId: string) => {
    const task = tasks.find(t => t.id === taskId)
    if (!task || task.completed) return
    // Mark this task complete
    const updatedTasks = tasks.map(t => t.id === taskId ? { ...t, completed: true } : t)
    // If it's a child, check if all siblings are now complete → auto-complete parent
    let parentToComplete: string | null = null
    if (task.parent_id) {
      const siblings = updatedTasks.filter(t => t.parent_id === task.parent_id)
      const allDone = siblings.every(t => t.completed)
      const parent = updatedTasks.find(t => t.id === task.parent_id)
      if (allDone && parent && !parent.completed) {
        parentToComplete = task.parent_id
      }
    }
    setTasks(parentToComplete
      ? updatedTasks.map(t => t.id === parentToComplete ? { ...t, completed: true } : t)
      : updatedTasks)
    startTransition(async () => {
      await getRepository().completeTask(taskId)
      if (parentToComplete) await getRepository().completeTask(parentToComplete)
    })
  }

  const handleDelete = (taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId && t.parent_id !== taskId))
    startTransition(async () => { await getRepository().deleteTask(taskId) })
  }

  const handleToggleToday = (task: LongTermTask) => {
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, is_for_today: !t.is_for_today } : t))
    startTransition(async () => { await getRepository().setTaskForToday(task.id, !task.is_for_today) })
  }

  const handleAdd = () => {
    if (!name.trim()) return
    startTransition(async () => {
      await getRepository().addTask(name.trim(), category.trim())
      setName('')
      setCategory('')
      await reload()
    })
  }

  const handleClearCompleted = () => {
    const completedIds = tasks.filter(t => t.completed).map(t => t.id)
    if (completedIds.length === 0) return
    setTasks(prev => prev.filter(t => !t.completed))
    startTransition(async () => {
      for (const id of completedIds) {
        await getRepository().deleteTask(id)
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
      {/* Batch clear completed */}
      {tasks.some(t => t.completed) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
          <button
            onClick={handleClearCompleted}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '14px', padding: 0, fontFamily: 'inherit' }}
          >
            清除已完成
          </button>
        </div>
      )}

      {/* Add task form */}
      <div style={{
        display: 'flex', gap: '12px', padding: '8px 0 12px 0', marginBottom: '32px',
        borderBottom: '1px solid var(--border)',
      }}>
        <input
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="新任务名称"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '17px', color: 'var(--foreground)' }}
        />
        <input
          value={category} onChange={e => setCategory(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          placeholder="分类"
          style={{ width: '96px', background: 'transparent', border: 'none', outline: 'none', fontSize: '16px', color: 'var(--muted)' }}
        />
        <button
          onClick={handleAdd}
          style={{ padding: '4px 12px', background: 'none', color: 'var(--accent)', border: 'none', fontSize: '15px', cursor: 'pointer' }}
        >
          添加
        </button>
      </div>

      {categories.size === 0 && (
        <p style={{ color: 'var(--muted)', fontSize: '15px' }}>暂无任务</p>
      )}

      {[...categories.entries()].map(([cat, parentTasks]) => (
        <div key={cat} style={{ marginBottom: '48px' }}>
          {/* Category header */}
          <div style={{
            fontWeight: 700, fontSize: '22px',
            letterSpacing: '-0.02em',
            padding: '0',
            marginBottom: '12px',
            color: 'var(--foreground)',
          }}>
            {cat}
          </div>

          {parentTasks.map(task => (
            <div key={task.id}>
              {/* Parent task row */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '12px 0', borderBottom: '1px solid var(--border)',
                opacity: (task.completed || task.derivedCompleted) ? 0.6 : 1,
              }}>
                {/* Expand toggle */}
                <button
                  onClick={() => task.children.length > 0 && toggleExpand(task.id)}
                  style={{
                    width: '18px', height: '18px',
                    background: 'none', border: 'none', cursor: task.children.length > 0 ? 'pointer' : 'default',
                    color: 'var(--muted)', fontSize: '11px', padding: 0, flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  {task.children.length > 0 ? (expanded.has(task.id) ? '▼' : '▶') : ''}
                </button>

                {/* Complete checkbox */}
                <span
                  onClick={task.children.length > 0 ? undefined : () => handleComplete(task.id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: '16px', height: '16px',
                    borderRadius: '2px',
                    border: (task.completed || task.derivedCompleted) ? 'none' : '1.5px solid var(--border)',
                    background: (task.completed || task.derivedCompleted) ? 'var(--accent)' : 'transparent',
                    color: 'white', fontSize: '0.65em', fontWeight: 700,
                    cursor: task.children.length > 0 ? 'default' : 'pointer', flexShrink: 0,
                  }}
                >
                  {(task.completed || task.derivedCompleted) ? '✓' : ''}
                </span>

                <span style={{
                  flex: 1, fontSize: '17px', fontWeight: 400,
                  textDecoration: (task.completed || task.derivedCompleted) ? 'line-through' : 'none',
                  color: (task.completed || task.derivedCompleted) ? 'var(--muted)' : 'var(--foreground)',
                }}>{task.name}</span>

                {/* Sub-task count badge */}
                {task.children.length > 0 && !expanded.has(task.id) && (
                  <span style={{ fontSize: '13px', color: 'var(--muted)', flexShrink: 0 }}>
                    {task.children.filter(c => c.completed).length}/{task.children.length}
                  </span>
                )}

                {task.delay_days > 0 && (
                  <span style={{ fontSize: '13px', color: '#d96060', flexShrink: 0 }}>拖{task.delay_days}天</span>
                )}

                {/* Today toggle (only for tasks without children) */}
                {task.children.length === 0 && (
                  <button
                    onClick={() => handleToggleToday(task)}
                    style={{
                      fontSize: '13px', padding: '4px 10px',
                      border: `1px solid ${task.is_for_today ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: '2px', cursor: 'pointer',
                      background: task.is_for_today ? 'var(--accent)' : 'transparent',
                      color: task.is_for_today ? 'white' : 'var(--muted)',
                      flexShrink: 0,
                    }}
                  >
                    今天
                  </button>
                )}

                <button
                  onClick={() => handleDelete(task.id)}
                  style={{ fontSize: '17px', color: 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px', flexShrink: 0, lineHeight: 1 }}
                >
                  ×
                </button>
              </div>

              {/* Sub-tasks */}
              {expanded.has(task.id) && task.children.map(child => (
                <TaskRow
                  key={child.id}
                  task={child}
                  indent
                  onComplete={handleComplete}
                  onDelete={handleDelete}
                  onToggleToday={handleToggleToday}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
