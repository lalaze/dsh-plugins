import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APP_ENTRY, APP_ROUTE, LOCAL_ROUTE } from '../src/shared/protocol.js'
import { appFiles, isRoutePath } from '../src/index.js'

// DSH refuses a route with an empty segment by throwing, which unloads the plugin: `/api/dsh-mobile/app/` did.
test('every route the plugin registers is one DSH accepts', () => {
  const built = ['index.html', 'app.js', 'app.css', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']
  assert.deepEqual(appFiles(built), built)
  for (const path of [LOCAL_ROUTE, APP_ENTRY, ...built.map(file => `${APP_ROUTE}/${file}`)]) assert.ok(isRoutePath(path), path)
  for (const path of [`${APP_ROUTE}/`, '/api', '/api/a//b', '/api/a/../b', '/other/x', '/api/a b']) assert.equal(isRoutePath(path), false, path)
})
