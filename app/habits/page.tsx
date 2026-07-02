'use client'

import Link from 'next/link'
import HabitManagement from '@/components/HabitManagement'

export default function HabitsPage() {
  return (
    <div>
      <div style={{ marginBottom: '32px' }}>
        <Link href="/" style={{ color: 'var(--accent)', fontSize: '15px', textDecoration: 'none' }}>← 返回</Link>
      </div>
      <h1 style={{ fontSize: '28px', fontWeight: 700, letterSpacing: '-0.02em', marginBottom: '32px' }}>习惯管理</h1>
      <HabitManagement />
    </div>
  )
}
