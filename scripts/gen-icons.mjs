// Reproducible PWA icon generator — Node built-ins ONLY (node:fs, node:zlib).
// No sharp/canvas/pngjs. Emits three solid design-system PNGs:
//   public/icon-192.png (192x192), public/icon-512.png (512x512),
//   public/apple-touch-icon.png (180x180)
// Design system (~/.claude/CLAUDE.md): white field #ffffff with a centered
// filled square of Action-Blue #0066cc occupying the middle ~60%. Single
// accent, no gradient — replace these three files later with real artwork.
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

// Standard PNG CRC32 (precomputed table).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

// Solid white field with a centered #0066cc square (~60% of the side).
function makePng(size) {
  const WHITE = [255, 255, 255]
  const BLUE = [0, 102, 204]
  const inset = Math.round(size * 0.2) // 20% margin each side -> 60% square
  const lo = inset
  const hi = size - inset
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3)
    raw[rowStart] = 0 // filter type 0 (None)
    for (let x = 0; x < size; x++) {
      const inSquare = x >= lo && x < hi && y >= lo && y < hi
      const [r, g, b] = inSquare ? BLUE : WHITE
      const p = rowStart + 1 + x * 3
      raw[p] = r
      raw[p + 1] = g
      raw[p + 2] = b
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type 2 = RGB (truecolor)
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

for (const [file, size] of [
  ['public/icon-192.png', 192],
  ['public/icon-512.png', 512],
  ['public/apple-touch-icon.png', 180],
]) {
  writeFileSync(file, makePng(size))
  console.log(`wrote ${file} (${size}x${size})`)
}
