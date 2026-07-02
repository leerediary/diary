'use client'

import { useEffect, useState } from 'react'
import { getRepository } from '@/lib/repository-provider'
import type { LongTermTask } from '@/lib/types'
import TaskList from '@/components/TaskList'

export default function TasksPage() {
  const [tasks, setTasks] = useState<LongTermTask[] | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const all = await getRepository().listAllTasks()
      if (!cancelled) setTasks(all)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div>
      <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '32px' }}>长期任务</h1>
      {tasks === null ? (
        <p style={{ color: 'var(--muted)', fontSize: '15px' }}>加载中…</p>
      ) : (
        <TaskList tasks={tasks} />
      )}
    </div>
  )
}
