'use client'

/**
 * DataPortability — export/import affordance for the diary-web↔native contract (Phase 19 / D-09).
 *
 * Two Action-Blue text buttons: 「导出数据」and 「导入数据」. Export downloads a
 * diary-export-YYYY-MM-DD.json (D-08 contract) via exportData(). Import reads a
 * user-selected JSON file, calls importData() (repository-agnostic, no DOM), and
 * reloads the page on success so the app reflects the imported rows.
 *
 * Design constraints (CLAUDE.md Apple Design System, mirroring AccountEntry):
 *   - Action Blue #0066cc ONLY on the two interactive buttons
 *   - No shadow (no boxShadow), no weight 500; SF Pro fallback stack; 14px quiet size
 *   - background:none, border:none, padding:0, cursor:pointer
 *   - The hidden file input is display:none
 */

import { useRef } from 'react'
import { exportData } from '@/lib/data-export'
import { importData } from '@/lib/data-import'
import { ACTION_BLUE_BUTTON } from '@/components/shared-styles'

export default function DataPortability() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExport = () => {
    exportData().catch((e) => console.error('export failed:', e))
  }

  const handleImportClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      await importData(text)
      location.reload()
    } catch (err) {
      console.error('import failed:', err)
      alert(err instanceof Error ? err.message : '导入失败：文件格式无效')
    } finally {
      // Reset so re-selecting the same file fires onChange again
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif' }}>
      <button onClick={handleExport} style={ACTION_BLUE_BUTTON}>
        导出数据
      </button>
      <button onClick={handleImportClick} style={ACTION_BLUE_BUTTON}>
        导入数据
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  )
}
