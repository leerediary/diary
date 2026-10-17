import { describe, it, expect } from 'vitest'
import { CHANGELOG, LATEST_VERSION } from '@/lib/changelog'

describe('changelog', () => {
  it('has at least one entry', () => {
    expect(CHANGELOG.length).toBeGreaterThan(0)
  })

  it('LATEST_VERSION matches the newest (first) entry', () => {
    expect(LATEST_VERSION).toBe(CHANGELOG[0].version)
  })

  it('every entry has the required fields', () => {
    for (const e of CHANGELOG) {
      expect(typeof e.version).toBe('string')
      expect(e.version.length).toBeGreaterThan(0)
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(typeof e.title).toBe('string')
      expect(e.title.length).toBeGreaterThan(0)
      expect(Array.isArray(e.notes)).toBe(true)
      expect(e.notes.length).toBeGreaterThan(0)
    }
  })

  it('versions are unique', () => {
    const versions = CHANGELOG.map((e) => e.version)
    expect(new Set(versions).size).toBe(versions.length)
  })
})
