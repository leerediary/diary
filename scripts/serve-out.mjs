// Dependency-free static server for the out/ export — the local harness for
// the 04-03 manual offline checkpoint. node:http + node:fs + node:path only
// (NO express/serve). localhost is a secure context, so the service worker
// registers without HTTPS (04-RESEARCH §5).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const ROOT = join(process.cwd(), 'out')
const PORT = 3000
const PREFIX = process.env.BASE_PATH || ''  // Phase 20: subpath serve harness

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
}

function resolve(urlPath) {
  // Decode + strip query, prevent path traversal outside ROOT.
  const clean = decodeURIComponent(urlPath.split('?')[0])
  // Phase 20: strip BASE_PATH prefix before path mapping (e.g. /diary-web/ → /).
  const stripped = PREFIX && clean.startsWith(PREFIX)
    ? (clean.slice(PREFIX.length) || '/')
    : clean
  const rel = normalize(stripped).replace(/^(\.\.[/\\])+/, '')
  let p = join(ROOT, rel)
  if (!p.startsWith(ROOT)) return null
  // Map trailing-slash to index.html using the original clean path for
  // directory routing (e.g. /diary-web/ → index.html).
  if (clean === '/' || clean.endsWith('/')) return join(p, 'index.html')
  if (extname(p)) return p
  // Extensionless static-export routing: <path>.html then <path>/index.html.
  if (existsSync(p + '.html')) return p + '.html'
  if (existsSync(join(p, 'index.html'))) return join(p, 'index.html')
  return p
}

const server = createServer(async (req, res) => {
  let file = resolve(req.url || '/')
  if (!file || !existsSync(file)) {
    const notFound = join(ROOT, '404.html')
    const body = existsSync(notFound) ? await readFile(notFound) : 'Not Found'
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
    return
  }
  try {
    const body = await readFile(file)
    const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }
    // headers() is unsupported under output:'export' — this local harness
    // stands in for the production proxy. Content-hashed assets are immutable
    // and safe to cache forever; everything else (HTML shells, sw.js,
    // sw-policy.js, manifest) must be no-cache, otherwise the browser HTTP
    // cache pins a stale shell that the SW then precaches on install — a
    // version bump can never dislodge it (04-RESEARCH §5).
    headers['Cache-Control'] = ((req.url || '').startsWith(PREFIX + '/_next/static/') || (req.url || '').startsWith('/_next/static/'))
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'
    res.writeHead(200, headers)
    res.end(body)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('Server error: ' + (e?.message ?? e))
  }
})

server.listen(PORT, () => {
  console.log(`Serving out/ → http://localhost:${PORT}`)
})
