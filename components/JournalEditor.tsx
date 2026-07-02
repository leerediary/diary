'use client'

import { useState, useRef } from 'react'
import { getRepository } from '@/lib/repository-provider'

interface Props {
  date: string
  initialContent: string
  readonly?: boolean
}

export default function JournalEditor({ date, initialContent, readonly }: Props) {
  const [content, setContent] = useState(initialContent)
  const [saved, setSaved] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleChange = (v: string) => {
    if (readonly) return
    setContent(v)
    setSaved(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      await getRepository().saveJournal(date, v)
      setSaved(true)
    }, 800)
  }

  return (
    <div>
      <textarea
        value={content}
        onChange={e => handleChange(e.target.value)}
        readOnly={readonly}
        placeholder={readonly ? '（当日无日记记录）' : '今天发生了什么…'}
        rows={6}
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid var(--border)',
          borderRadius: 0,
          padding: '8px 0',
          fontSize: '17px',
          color: 'var(--foreground)',
          resize: 'vertical',
          outline: 'none',
          lineHeight: 1.47,
          fontFamily: 'inherit',
          opacity: readonly && !content ? 0.5 : 1,
        }}
      />
      {!readonly && (
        <div style={{ fontSize: '13px', color: 'var(--muted)', marginTop: '8px', textAlign: 'right' }}>
          {saved ? '已保存' : '保存中…'}
        </div>
      )}
    </div>
  )
}
