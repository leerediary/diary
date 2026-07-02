import type { MetadataRoute } from 'next'

// Special Route Handler. Next 16.2.6 requires the manifest route to explicitly
// opt into static rendering under output:'export' (the build fails asking for
// this exact directive). No Request-time API is used, so force-static is safe
// and emits a static out/manifest.webmanifest (04-RESEARCH §2.1). Apple design
// system: white surfaces, single accent, no gradient (~/.claude/CLAUDE.md).
export const dynamic = 'force-static'
export default function manifest(): MetadataRoute.Manifest {
  const base = process.env.NEXT_PUBLIC_BASE_PATH || ''
  return {
    name: '日记',
    short_name: '日记',
    description: '本地优先的个人日记 — 日记 / 习惯 / 任务',
    start_url: base + '/',
    scope: base + '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    lang: 'zh-CN',
    icons: [
      { src: base + '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: base + '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: base + '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
