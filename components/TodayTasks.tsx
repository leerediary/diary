'use client'

import { useState, useTransition } from 'react'
import { getRepository } from '@/lib/repository-provider'
import { LongTermTask } from '@/lib/types'

interface Props {
  tasks: LongTermTask[]
}

// Quick-added today tasks land under this category — keeps them grouped on the
// Tasks page and visually distinct from tagged long-term project tasks here.
const QUICK_CATEGORY = '临时'

export default function TodayTasks({ tasks: initial }: Props) {
  const [tasks, setTasks] = useState(initial)
  const [name, setName] = useState('')
  const [, startTransition] = useTransition()

  const complete = (taskId: string) => {
    setTasks(prev => prev.filter(t => t.id !== taskId))
    startTransition(async () => {
      await getRepository().completeTask(taskId)
    })
  }

  const add = () => {
    const n = name.trim()
    if (!n) return
    setName('')
    startTransition(async () => {
      const repo = getRepository()
      // isForToday=true → created already tagged for Today in one write.
      await repo.addTask(n, QUICK_CATEGORY, true)
      setTasks(await repo.listTodayTasks())
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Quick-add — creates a long_term_tasks row already tagged is_for_today. */}
      <div style={{
        display: 'flex', gap: '12px', padding: '8px 0 12px 0', marginBottom: '8px',
        borderBottom: '1px solid var(--border)',
      }}>
        <input
          value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && add()}
          placeholder="添加今日任务"
          style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '17px', color: 'var(--foreground)' }}
        />
        <button
          onClick={add}
          style={{ padding: '4px 12px', background: 'none', color: 'var(--accent)', border: 'none', fontSize: '15px', cursor: 'pointer' }}
        >
          添加
        </button>
      </div>

      {tasks.map(task => (
        <div
          key={task.id}
          style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
        >
          <span
            onClick={() => complete(task.id)}
            style={{
              display: 'inline-flex',
              width: '16px',
              height: '16px',
              borderRadius: '2px',
              border: '1.5px solid var(--border)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, fontSize: '17px' }}>{task.name}</span>
          {task.delay_days > 0 && (
            <span style={{ fontSize: '13px', color: '#d96060' }}>
              已拖延 {task.delay_days} 天
            </span>
          )}
          {task.category && (
            <span style={{ fontSize: '13px', color: 'var(--muted)' }}>
              {task.category}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
