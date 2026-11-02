// Builds the phone app into lib/app: a static site to host anywhere over HTTPS, and served by the plugin itself.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { build } from 'esbuild'

const packageDir = process.cwd()
const { version } = JSON.parse(await readFile(resolve(packageDir, 'package.json'), 'utf8'))
const out = resolve(packageDir, 'lib/app')
await mkdir(out, { recursive: true })

const common = { absWorkingDir: packageDir, bundle: true, minify: true, target: ['safari16', 'chrome110', 'firefox115'], legalComments: 'none', logLevel: 'warning' }
const app = await build({
  ...common, entryPoints: ['app/src/main.tsx'], outfile: 'lib/app/app.js', format: 'iife', platform: 'browser', write: false,
  define: { 'process.env.NODE_ENV': '"production"', __VERSION__: JSON.stringify(version) }, jsx: 'automatic',
})
const css = await build({ ...common, entryPoints: ['app/src/app.css'], outfile: 'lib/app/app.css', write: false })
const sw = await build({ ...common, entryPoints: ['app/src/sw.ts'], outfile: 'lib/app/sw.js', format: 'iife', platform: 'browser', write: false, define: { __VERSION__: JSON.stringify(`${version}-${Date.now().toString(36)}`) } })
for (const result of [app, css, sw]) for (const file of result.outputFiles) await writeFile(file.path, file.contents)
const stamp = createHash('sha256').update(app.outputFiles[0].contents).update(css.outputFiles[0].contents).digest('hex').slice(0, 10)

await writeFile(resolve(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111113" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="DSH">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss: ws:; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'">
<title>DSH</title>
<link rel="manifest" href="./manifest.webmanifest">
<link rel="apple-touch-icon" href="./icon-192.png">
<link rel="icon" href="./icon-192.png">
<link rel="stylesheet" href="./app.css?v=${stamp}">
</head>
<body>
<div id="root"></div>
<script src="./app.js?v=${stamp}"></script>
</body>
</html>
`)

await writeFile(resolve(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'DSH Mobile', short_name: 'DSH', id: './', start_url: './index.html', scope: './', display: 'standalone',
  background_color: '#111113', theme_color: '#111113', description: 'Read and steer your computer’s DSH sessions',
  icons: [192, 512].map(size => ({ src: `./icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })),
}, null, 2))

for (const size of [192, 512]) await writeFile(resolve(out, `icon-${size}.png`), icon(size))

/** A white chat bubble with three dots on DSH blue, drawn without a canvas. */
function icon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const blue = [59, 111, 224], white = [255, 255, 255]
  const roundRect = (x, y, cx, cy, w, h, r) => {
    const dx = Math.max(Math.abs(x - cx) - (w / 2 - r), 0), dy = Math.max(Math.abs(y - cy) - (h / 2 - r), 0)
    return Math.hypot(dx, dy) - r
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size
    let color = blue
    const bubble = roundRect(u, v, 0.5, 0.47, 0.6, 0.44, 0.13)
    // The tail: a triangle under the bubble's lower left.
    const tail = v > 0.6 && v < 0.78 && u > 0.3 && u < 0.44 && (u - 0.3) < (0.78 - v) * 0.8
    if (bubble < 0 || tail) color = white
    for (const cx of [0.36, 0.5, 0.64]) if (Math.hypot(u - cx, v - 0.47) < 0.045) color = blue
    const offset = (y * size + x) * 4
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2]; pixels[offset + 3] = 255
  }
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return ~crc >>> 0
}
