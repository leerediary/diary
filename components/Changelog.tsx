import { CHANGELOG, LATEST_VERSION } from '@/lib/changelog'

/**
 * In-app changelog (更新日志) shown on the settings page. Pure presentational
 * component over the static CHANGELOG array in lib/changelog.ts — no fetch, no
 * backend, works offline. Each entry is one manual publish.
 *
 * Apple design system: section header uses the muted 13px label matching the
 * rest of /settings; title weight 600 (no 500), muted secondary text, no
 * decorative chrome (~/.claude/CLAUDE.md).
 */
export default function Changelog() {
  return (
    <section id="changelog" style={{ marginTop: '48px' }}>
      <label
        style={{
          fontSize: '13px',
          color: 'var(--muted)',
          fontWeight: 400,
          marginBottom: '16px',
          display: 'block',
        }}
      >
        更新日志 · 当前版本 {LATEST_VERSION}
      </label>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {CHANGELOG.map((entry) => (
          <li key={entry.version} style={{ marginBottom: '24px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '8px',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: '15px', fontWeight: 600 }}>{entry.title}</span>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>
                {entry.version} · {entry.date}
              </span>
            </div>
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
              {entry.notes.map((note) => (
                <li
                  key={note}
                  style={{ fontSize: '15px', color: 'var(--muted)', marginTop: '4px' }}
                >
                  {note}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
