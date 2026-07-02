import type { Entity } from '@/lib/repository'
import { getLocalRepository } from '@/lib/repository-provider'
import { EXPORT_ENTITIES, EXPORT_FORMAT, EXPORT_VERSION } from '@/lib/data-export'

/**
 * Import a data-portability JSON string into the local repository.
 *
 * Repository-agnostic by design: uses `getLocalRepository()` to reach
 * `bulkLoadAll` (the local-only atomic multi-entity primitive), and
 * loads rows verbatim — preserving id, updated_at, deleted_at, and all
 * other fields. Tombstones are kept intact; timestamps are never re-stamped;
 * the outbox is never enqueued (bulkLoadAll is a raw Dexie bulkPut with no
 * sync side effects).
 *
 * This function is pure — zero DOM access. Phase 20's native SQLite
 * path reuses it unchanged by calling `importData(json)` from Swift
 * via `evaluateJavaScript`.
 *
 * Validation runs BEFORE any write, and all writes are in ONE atomic
 * transaction — so any per-row failure (bad shape, or the journal_entries
 * `&date` unique-index collision) rolls back ALL entities. The store is
 * genuinely untouched on failure.
 */
export async function importData(json: string): Promise<void> {
  // 1. Parse
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('导入失败：文件内容不是有效的 JSON')
  }

  // 2. Validate — all checks before any bulkLoad
  if (parsed == null || typeof parsed !== 'object') {
    throw new Error('导入失败：文件格式不正确（期望一个 JSON 对象）')
  }
  const obj = parsed as Record<string, unknown>

  if (obj.format !== EXPORT_FORMAT) {
    throw new Error(`导入失败：文件格式不匹配（期望 "${EXPORT_FORMAT}"，实际是 "${String(obj.format)}"）`)
  }

  if (typeof obj.version !== 'number') {
    throw new Error('导入失败：缺少版本号')
  }
  // Future compatibility: accept any numeric version we know how to handle.
  // For now we only handle version 1.
  if (obj.version !== EXPORT_VERSION) {
    throw new Error(`导入失败：不支持的版本 ${obj.version}（当前支持版本 ${EXPORT_VERSION}）`)
  }

  const data = obj.data
  if (data == null || typeof data !== 'object') {
    throw new Error('导入失败：缺少 data 字段或格式不正确')
  }

  for (const entity of EXPORT_ENTITIES) {
    const rows = (data as Record<string, unknown>)[entity]
    if (!Array.isArray(rows)) {
      throw new Error(`导入失败：data.${entity} 不是数组`)
    }
  }

  // 3. Load every entity in ONE atomic transaction (EXPORT_ENTITIES order).
  //    Atomicity is load-bearing: a per-row failure (bad shape, or the
  //    journal_entries `&date` unique-index collision when merging into a
  //    non-empty store) rolls back ALL writes.
  const entries = EXPORT_ENTITIES.map(
    (entity) => [entity as Entity, (data as Record<string, unknown[]>)[entity]] as const,
  )
  await getLocalRepository().bulkLoadAll(entries)
}
