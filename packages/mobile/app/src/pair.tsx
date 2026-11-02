/** Pair with a computer: scan the code it shows, or paste its link. */
import jsQRModule from 'jsqr'
import React, { useEffect, useRef, useState } from 'react'
import { errorText, ui } from './i18n.js'
import { store, useStore } from './store.js'

// jsqr is CommonJS: its function is the module itself, with a `default` copy.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as unknown as typeof import('jsqr').default

export function PairScreen({ initial, onDone, onCancel }: { initial?: string; onDone(hubId: string): void; onCancel?(): void }) {
  useStore()
  const [link, setLink] = useState('')
  const [error, setError] = useState<string>()
  const [scanning, setScanning] = useState(false)
  const [pending, setPending] = useState<string | undefined>(initial)
  const state = pending ? store.hubs.get(pending) : undefined

  useEffect(() => { if (state?.client.info?.phone) onDone(state.hub.hubId) }, [state?.client.info?.phone])

  const submit = (text: string) => {
    setError(undefined)
    try { setPending(store.add(text)); setScanning(false) } catch (failure) { setError(errorText(failure)) }
  }

  if (state && !state.client.info?.phone) {
    const code = state.client.info?.pairing?.code
    return <div className="screen center-screen">
      <div className="pair-box">
        {code
          ? <><p>{ui('Confirm on {0} that it shows this code:', { 0: state.hub.name })}</p><div className="code">{code.slice(0, 3)} {code.slice(3)}</div></>
          : <p>{state.client.state === 'unpaired' || state.client.state === 'offline' ? ui(state.client.error ?? 'Offline') : ui('Connecting…')}</p>}
        <button className="button" onClick={() => { store.remove(state.hub.hubId); setPending(undefined) }}>{ui('Cancel')}</button>
      </div>
    </div>
  }

  return <div className="screen">
    <header className="bar">
      {onCancel && <button className="icon" aria-label={ui('Back')} onClick={onCancel}><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M15 5l-7 7 7 7" /></svg></button>}
      <div className="bar-title"><div className="title-line big">{ui('Pair with a computer')}</div></div>
    </header>
    <div className="scroll form">
      <p className="muted">{ui('On the computer, open DSH → Settings → Phone access and select Pair a phone. Then scan its code here, or open the link it shows on this phone.')}</p>
      {scanning ? <Scanner onCode={submit} onError={message => { setError(message); setScanning(false) }} /> : null}
      <button className="button primary wide" onClick={() => setScanning(!scanning)}>{scanning ? ui('Stop scanning') : ui('Scan code')}</button>
      <form className="field" onSubmit={event => { event.preventDefault(); submit(link) }}>
        <span>{ui('Or paste the pairing link')}</span>
        <div className="inline-form">
          <input className="input" value={link} onChange={event => setLink(event.target.value)} placeholder="https://…#pair=…" autoCapitalize="off" autoCorrect="off" />
          <button className="button" disabled={!link.trim()}>{ui('Pair')}</button>
        </div>
      </form>
      {error && <div className="error inline" role="alert">{error}</div>}
    </div>
  </div>
}

function Scanner({ onCode, onError }: { onCode(text: string): void; onError(message: string): void }) {
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    let stream: MediaStream | undefined, frame = 0, stopped = false
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true })!
    const tick = () => {
      if (stopped) return
      const element = video.current
      if (element && element.readyState >= 2 && element.videoWidth) {
        const scale = Math.min(1, 720 / Math.max(element.videoWidth, element.videoHeight))
        canvas.width = Math.round(element.videoWidth * scale); canvas.height = Math.round(element.videoHeight * scale)
        context.drawImage(element, 0, 0, canvas.width, canvas.height)
        const found = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
        if (found?.data.includes('#pair=')) { stopped = true; onCode(found.data); return }
      }
      frame = requestAnimationFrame(tick)
    }
    if (!navigator.mediaDevices?.getUserMedia) { onError(ui('Camera is not available here. Paste the link instead.')); return }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(media => {
      if (stopped) { media.getTracks().forEach(track => track.stop()); return }
      stream = media
      video.current!.srcObject = media
      void video.current!.play()
      frame = requestAnimationFrame(tick)
    }, () => onError(ui('Camera is not available here. Paste the link instead.')))
    return () => { stopped = true; cancelAnimationFrame(frame); stream?.getTracks().forEach(track => track.stop()) }
  }, [])
  return <div className="scanner"><video ref={video} playsInline muted /></div>
}
