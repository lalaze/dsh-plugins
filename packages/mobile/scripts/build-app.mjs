// Builds the phone app into lib/app: a static site to host anywhere over HTTPS, and served by the plugin itself.
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
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
// Icons keep their names, so their URLs carry a hash: a CDN in front of the app would otherwise serve old ones for hours.
const iconStamp = createHash('sha256').update(await readFile(resolve(packageDir, 'app/assets/icon-512.png'))).update(await readFile(resolve(packageDir, 'app/assets/favicon.svg'))).digest('hex').slice(0, 10)

await writeFile(resolve(out, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#18181b" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="DeepSeek Harness">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss: ws:; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'">
<title>DeepSeek Harness</title>
<link rel="manifest" href="./manifest.webmanifest?v=${iconStamp}">
<link rel="apple-touch-icon" href="./apple-touch-icon.png?v=${iconStamp}">
<link rel="icon" type="image/svg+xml" href="./favicon.svg?v=${iconStamp}" media="(prefers-color-scheme: light)">
<link rel="icon" type="image/svg+xml" href="./favicon-dark.svg?v=${iconStamp}" media="(prefers-color-scheme: dark)">
<link rel="stylesheet" href="./app.css?v=${stamp}">
</head>
<body>
<div id="root"></div>
<script src="./app.js?v=${stamp}"></script>
</body>
</html>
`)

await writeFile(resolve(out, 'manifest.webmanifest'), JSON.stringify({
  name: 'DeepSeek Harness', short_name: 'DSH', id: './', start_url: './index.html', scope: './', display: 'standalone',
  background_color: '#ffffff', theme_color: '#ffffff', description: 'Read and steer your computers’ DeepSeek Harness sessions',
  icons: [192, 512].map(size => ({ src: `./icon-${size}.png?v=${iconStamp}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })),
}, null, 2))

// DeepSeek Harness's own icon (app/assets, from @deepseek-ai/dsh-web-frontend, MIT): the whale for the tab, PNGs for the home screen.
for (const file of ['favicon.svg', 'favicon-dark.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) await copyFile(resolve(packageDir, 'app/assets', file), resolve(out, file))
