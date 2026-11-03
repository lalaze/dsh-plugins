/** Message input with image attachments. Images are scaled down on the phone before they are sent. */
import React, { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PromptPart } from '../../src/shared/protocol.js'
import { icons } from './controls.js'
import { ui } from './i18n.js'
import { Lightbox } from './timeline.js'

export interface Draft { text: string; images: { name: string; mediaType: string; data: string; preview: string }[] }

const MAX_SIDE = 2048
const DRAFTS = 'dsh-mobile/drafts'
const drafts = new Map<string, Draft>()

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

const savedTexts = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(DRAFTS) ?? '{}') as Record<string, string> } catch { return {} } }

/**
 * A conversation's unsent message. Its text is also kept on the phone, so it survives the browser closing the app in
 * the background; images stay only while the app runs.
 */
export function useDraft(key: string): [Draft, (next: Draft) => void] {
  const [draft, setState] = useState<Draft>(() => drafts.get(key) ?? { text: savedTexts()[key] ?? '', images: [] })
  const set = (next: Draft) => {
    drafts.set(key, next)
    setState(next)
    const texts = savedTexts()
    if (next.text.trim()) texts[key] = next.text; else delete texts[key]
    try { localStorage.setItem(DRAFTS, JSON.stringify(texts)) } catch { /* storage full: the draft stays in memory */ }
  }
  return [draft, set]
}

export function Composer({ draft, onDraft, onSend, onStop, running, disabled, placeholder, busy, pills, images = true }: {
  draft: Draft
  onDraft(next: Draft): void
  onSend(): void
  onStop?(): void
  running?: boolean
  disabled?: boolean
  placeholder?: string
  busy?: boolean
  /** The session's controls under the input: model, reasoning, permission. */
  pills?: ReactNode
  /** Whether images can be attached; background tasks take text only. */
  images?: boolean
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const files = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [preview, setPreview] = useState<Draft['images'][number]>()
  useEffect(() => {
    const element = input.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 168)}px`
  }, [draft.text])
  const empty = !draft.text.trim() && draft.images.length === 0
  // Like Paseo: with nothing typed, the button stops a running task; with a message, it interrupts and sends.
  const stopping = running && empty && onStop
  return <div className="composer-wrap">
    <form className="composer" onSubmit={event => { event.preventDefault(); if (stopping) onStop!(); else if (!empty) onSend() }}>
      {draft.images.length > 0 && <div className="composer-images">{draft.images.map((image, index) => <div key={index} className="composer-image">
        <button type="button" className="thumb-button" onClick={() => setPreview(image)}><img src={image.preview} alt={image.name} /></button>
        <button type="button" className="remove" aria-label={ui('Remove image')} onClick={() => { URL.revokeObjectURL(image.preview); onDraft({ ...draft, images: draft.images.filter((_, i) => i !== index) }) }}>{icons.close}</button>
      </div>)}</div>}
      <textarea ref={input} rows={1} value={draft.text} disabled={disabled}
        placeholder={placeholder ?? (running && onStop ? ui('Message — interrupts the current turn') : ui('Message'))}
        onChange={event => onDraft({ ...draft, text: event.target.value })}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!empty) onSend() } }} />
      <div className="composer-bar">
        {images && <button type="button" className="attach" aria-label={ui('Add image')} disabled={disabled || reading} onClick={() => files.current?.click()}>
          {reading ? <span className="spinner small" /> : icons.attach}
        </button>}
        <input ref={files} type="file" accept="image/*" multiple hidden onChange={async event => {
          const list = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (!list.length) return
          setReading(true)
          try { onDraft({ ...draft, images: [...draft.images, ...await Promise.all(list.slice(0, 8).map(readImage))] }) } finally { setReading(false) }
        }} />
        <div className="pills">{pills}</div>
        <button type="submit" className={`send${stopping ? ' stop' : ''}`} disabled={disabled || busy || reading || (empty && !stopping)}
          aria-label={stopping ? ui('Stop') : running ? ui('Interrupt and send') : ui('Send')}>
          {busy ? <span className="spinner small light" /> : stopping ? icons.stop : icons.arrowUp}
        </button>
      </div>
    </form>
    {preview && <Lightbox url={preview.preview} name={preview.name} onClose={() => setPreview(undefined)} />}
  </div>
}
