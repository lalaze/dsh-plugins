/** The phone app: hash routes for the session list, a session, a new session, settings and pairing. */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionList } from './list.js'
import { NewSession } from './new.js'
import { PairScreen } from './pair.js'
import { SessionView } from './session.js'
import { SettingsScreen } from './settings.js'
import { TaskView } from './task.js'
import { back, go, navDirection } from './nav.js'
import { store, useStore } from './store.js'

type Route = { name: 'list' } | { name: 'session'; hubId: string; sessionId: string } | { name: 'task'; hubId: string; taskId: string } | { name: 'new'; hubId: string } | { name: 'settings' } | { name: 'pair' }

function parse(hash: string): Route {
  const [name, hubId, sessionId] = hash.replace(/^#\/?/, '').split('/').map(part => { try { return decodeURIComponent(part) } catch { return part } })
  if (name === 's' && hubId && sessionId) return { name: 'session', hubId, sessionId }
  if (name === 't' && hubId && sessionId) return { name: 'task', hubId, taskId: sessionId }
  if (name === 'new' && hubId) return { name: 'new', hubId }
  if (name === 'settings') return { name: 'settings' }
  if (name === 'pair') return { name: 'pair' }
  return { name: 'list' }
}

/** A pairing link opened on this phone, also while the app is open: start pairing, then forget the link. */
function takePairingLink() {
  if (!location.hash.includes('pair=')) return
  try { store.add(location.href) } catch { /* the pair screen explains */ }
  history.replaceState(null, '', '#/')
}
takePairingLink()

function App() {
  useStore()
  const route = useRoute()
  const key = route.name === 'session' ? `s/${route.hubId}/${route.sessionId}` : route.name === 'task' ? `t/${route.hubId}/${route.taskId}` : route.name === 'new' ? `new/${route.hubId}` : route.name
  return <RouteView key={key} route={route} />
}

/** A screen slides in when the phone goes deeper and fades in when it comes back; closing a sheet changes neither. */
function RouteView({ route }: { route: Route }) {
  const [direction] = useState(navDirection)
  return <div className="route" data-nav={direction}><Screen route={route} /></div>
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const update = () => { takePairingLink(); setRoute(parse(location.hash)) }
    addEventListener('hashchange', update); addEventListener('popstate', update)
    // A tapped notification asks the open app to show its session.
    const message = (event: MessageEvent) => { if (event.data?.type === 'open' && event.data.hubId && event.data.sessionId) go(`s/${encodeURIComponent(event.data.hubId)}/${encodeURIComponent(event.data.sessionId)}`) }
    navigator.serviceWorker?.addEventListener('message', message)
    return () => { removeEventListener('hashchange', update); removeEventListener('popstate', update); navigator.serviceWorker?.removeEventListener('message', message) }
  }, [])
  return route
}

function Screen({ route }: { route: Route }) {
  // A computer still being paired keeps the pairing screen up until it confirms or the phone cancels.
  const pairing = [...store.hubs.values()].find(state => state.hub.token !== undefined)
  if (store.hubs.size === 0 || route.name === 'pair' || pairing) {
    const others = [...store.hubs.values()].some(state => state.hub.token === undefined)
    return <PairScreen key={pairing?.hub.hubId ?? 'new'} initial={pairing?.hub.hubId} onDone={() => go('', true)} onCancel={others ? () => { if (pairing) store.remove(pairing.hub.hubId); back() } : undefined} />
  }
  if (route.name === 'session') {
    const state = store.hubs.get(route.hubId)
    if (state) return <SessionView key={`${route.hubId}/${route.sessionId}`} state={state} sessionId={route.sessionId} onBack={back} />
  }
  if (route.name === 'task') {
    const state = store.hubs.get(route.hubId)
    if (state) return <TaskView key={`${route.hubId}/${route.taskId}`} state={state} taskId={route.taskId} onBack={back} onOpenSession={sessionId => go(`s/${encodeURIComponent(route.hubId)}/${encodeURIComponent(sessionId)}`)} />
  }
  if (route.name === 'new' && store.hubs.has(route.hubId)) {
    return <NewSession hubId={route.hubId} onBack={back} onCreated={sessionId => go(`s/${encodeURIComponent(route.hubId)}/${encodeURIComponent(sessionId)}`, true)} />
  }
  if (route.name === 'settings') return <SettingsScreen onBack={back} onPair={() => go('pair')} />
  return <SessionList onOpen={(hubId, sessionId) => go(`s/${encodeURIComponent(hubId)}/${encodeURIComponent(sessionId)}`)} onOpenTask={(hubId, taskId) => go(`t/${encodeURIComponent(hubId)}/${encodeURIComponent(taskId)}`)} onNew={hubId => go(`new/${encodeURIComponent(hubId)}`)} onSettings={() => go('settings')} />
}

if ('serviceWorker' in navigator) void navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => { /* notifications stay off */ })
createRoot(document.getElementById('root')!).render(<App />)
