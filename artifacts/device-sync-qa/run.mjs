// Isolated browser regression fixture, not a replacement DSH server.
// Run from repository root: node artifacts/device-sync-qa/run.mjs
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const dir = fileURLToPath(new URL('.', import.meta.url))
await build({entryPoints:[`${dir}browser.tsx`],bundle:true,platform:'browser',format:'iife',outfile:`${dir}browser.js`,define:{'process.env.NODE_ENV':'"production"'}})
const dom = execFileSync(process.env.CHROME || 'google-chrome', ['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--virtual-time-budget=34000','--dump-dom',new URL('index.html', import.meta.url).href], {encoding:'utf8',maxBuffer:5_000_000,timeout:30_000,stdio:['ignore','pipe','pipe']})
const text = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1]
if (!text || text === 'pending') throw new Error('Browser fixture did not finish')
const result = JSON.parse(text.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'))
console.log(JSON.stringify(result,null,2))
writeFileSync(`${dir}result.json`,JSON.stringify(result,null,2)+'\n')
if (!result.ok) process.exitCode = 1
