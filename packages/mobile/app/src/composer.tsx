/** Message input with image attachments. Images are scaled down on the phone before they are sent. */
import React, { useEffect, useRef, useState } from 'react'
import type { PromptPart } from '../../src/shared/protocol.js'
import { ui } from './i18n.js'

export interface Draft { text: string; images: { name: string; mediaType: string; data: string; preview: string }[] }

const MAX_SIDE = 2048

/** Read an image file and scale it to at most 2048 pixels on its long side, as JPEG unless it is a small PNG. */
export async function readImage(file: File): Promise<Draft['images'][number]> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const keep = file.type === 'image/png' && scale === 1 && file.size < 1_500_000
  let blob: Blob = file
  if (!keep) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not read the image')), 'image/jpeg', 0.85))
  }
  bitmap.close()
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]+,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return { name: file.name || 'image', mediaType: blob.type || 'image/jpeg', data, preview: URL.createObjectURL(blob) }
}

export const draftContent = (draft: Draft): PromptPart[] => [
  ...draft.images.map(image => ({ type: 'image' as const, mediaType: image.mediaType, data: image.data, name: image.name })),
  ...(draft.text.trim() ? [{ type: 'text' as const, text: draft.text }] : []),
]

export function Composer({ draft, onDraft, onSend, onStop, running, disabled, placeholder, busy }: {
  draft: Draft
  onDraft(next: Draft): void
  onSend(): void
  onStop?(): void
  running?: boolean
  disabled?: boolean
  placeholder?: string
  busy?: boolean
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [draft.text])
  const empty = !draft.text.trim() && draft.images.length === 0
  // Like Paseo: with nothing typed, the button stops a running task; with a message, it interrupts and sends.
  const stopping = running && empty && onStop
  return <form className="composer" onSubmit={event => { event.preventDefault(); if (stopping) onStop!(); else if (!empty) onSend() }}>
    {draft.images.length > 0 && <div className="composer-images">{draft.images.map((image, index) => <div key={index} className="composer-image">
      <img src={image.preview} alt={image.name} />
      <button type="button" aria-label={ui('Remove image')} onClick={() => { URL.revokeObjectURL(image.preview); onDraft({ ...draft, images: draft.images.filter((_, i) => i !== index) }) }}>×</button>
    </div>)}</div>}
    <div className="composer-row">
      <button type="button" className="icon" aria-label={ui('Add image')} disabled={disabled || reading} onClick={() => files.current?.click()}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M12 5v14M5 12h14" /></svg>
      </button>
      <input ref={files} type="file" accept="image/*" multiple hidden onChange={async event => {
        const list = Array.from(event.target.files ?? [])
        event.target.value = ''
        if (!list.length) return
        setReading(true)
        try { onDraft({ ...draft, images: [...draft.images, ...await Promise.all(list.slice(0, 8).map(readImage))] }) } finally { setReading(false) }
      }} />
      <textarea ref={input} rows={1} value={draft.text} placeholder={placeholder ?? ui('Message')} disabled={disabled} enterKeyHint="send"
        onChange={event => onDraft({ ...draft, text: event.target.value })}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!empty) onSend() } }} />
      <button type="submit" className={`send${stopping ? ' stop' : ''}`} disabled={disabled || busy || reading || (empty && !stopping)}
        aria-label={stopping ? ui('Stop') : running ? ui('Interrupt and send') : ui('Send')}>
        {stopping
          ? <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
          : <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 19V5M6 11l6-6 6 6" /></svg>}
      </button>
    </div>
  </form>
}
