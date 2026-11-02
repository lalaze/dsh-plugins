/// <reference lib="webworker" />
/**
 * Service worker: keeps the app shell for offline starts and shows notifications this phone's computers send. A
 * notification for the session already on screen is skipped.
 */
declare const self: ServiceWorkerGlobalScope
declare const __VERSION__: string

const CACHE = `dsh-mobile-${__VERSION__}`
const SHELL = ['./index.html', './app.js', './app.css', './manifest.webmanifest', './icon-192.png', './icon-512.png']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('dsh-mobile-') && key !== CACHE) await caches.delete(key)
    await self.clients.claim()
  })())
})

// Network first, so a new version arrives as soon as it is online; the cache serves offline starts. Requests
// revalidate with the server even when a CDN in front of it hands out long browser cache lifetimes.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.registration.scope).pathname)) return
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: 'no-cache' })
      if (response.ok) { const copy = response.clone(); void caches.open(CACHE).then(cache => cache.put(event.request, copy)) }
      return response
    } catch {
      return (await caches.match(event.request, { ignoreSearch: true })) ?? (await caches.match('./index.html')) ?? Response.error()
    }
  })())
})

interface Payload { title: string; body: string; tag: string; hubId: string; sessionId?: string }

const sessionPath = (payload: { hubId: string; sessionId?: string }) => payload.sessionId ? `#/s/${encodeURIComponent(payload.hubId)}/${encodeURIComponent(payload.sessionId)}` : '#/'

self.addEventListener('push', event => {
  let payload: Payload
  try { payload = event.data!.json() as Payload } catch { return }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const watching = windows.some(client => client.visibilityState === 'visible' && (payload.sessionId ? new URL(client.url).hash === sessionPath(payload) : false))
    if (watching) return
    await self.registration.showNotification(payload.title, {
      body: payload.body, tag: payload.tag, icon: './icon-192.png', badge: './icon-192.png',
      data: { hubId: payload.hubId, sessionId: payload.sessionId },
    })
  })())
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const data = event.notification.data as { hubId: string; sessionId?: string }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const target = windows[0] as WindowClient | undefined
    if (target) {
      await target.focus()
      target.postMessage({ type: 'open', ...data })
      return
    }
    await self.clients.openWindow(new URL(`./${sessionPath(data)}`, self.registration.scope).toString())
  })())
})
