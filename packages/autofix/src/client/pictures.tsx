import React, { useEffect, useRef, useState } from 'react';
import { ui } from './i18n.js';

export const MAX_PICTURES = 8, MAX_BYTES = 10 * 1024 * 1024;
export interface Picture { id: number; name: string; mediaType: string; data: string; url: string }
let serial = 0;
/** A file as base64, which is how a picture travels in the request. */
const encode = (file: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ''));
  reader.readAsDataURL(file);
});

/**
 * The pictures a person is adding to a form: from the file chooser, pasted from the clipboard, or dropped. `zone` goes
 * on the form so a screenshot pasted or dropped anywhere in it lands here; `over` is true while one hovers.
 */
export function usePictures() {
  const [pictures, setPictures] = useState<Picture[]>([]), [note, setNote] = useState(''), [over, setOver] = useState(false);
  const kept = useRef<Picture[]>([]), chooser = useRef<HTMLInputElement>(null);
  kept.current = pictures;
  useEffect(() => () => { for (const picture of kept.current) URL.revokeObjectURL(picture.url); }, []);
  const add = async (files: readonly File[]) => {
    const images = files.filter(file => /^image\/(?:png|jpeg|webp|gif)$/u.test(file.type));
    if (!images.length) { if (files.length) setNote(ui("Only PNG, JPEG, WebP and GIF pictures can be added.")); return; }
    const room = MAX_PICTURES - kept.current.length, taken = images.filter(file => file.size <= MAX_BYTES).slice(0, Math.max(0, room));
    setNote(images.some(file => file.size > MAX_BYTES) ? ui("A picture larger than 10 MB was left out.") : images.length > room ? ui("At most {0} pictures.", { 0: String(MAX_PICTURES) }) : '');
    const read = await Promise.all(taken.map(async file => ({ id: ++serial, name: file.name || 'picture', mediaType: file.type, data: await encode(file), url: URL.createObjectURL(file) })));
    setPictures(current => [...current, ...read]);
  };
  const remove = (id: number) => setPictures(current => current.filter(picture => { if (picture.id === id) URL.revokeObjectURL(picture.url); return picture.id !== id; }));
  const clear = () => { for (const picture of kept.current) URL.revokeObjectURL(picture.url); setPictures([]); setNote(''); };
  const zone = {
    'data-over': over || undefined,
    onPaste: (event: React.ClipboardEvent) => { const files = Array.from(event.clipboardData.files); if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); void add(files); } },
    onDragOver: (event: React.DragEvent) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (event: React.DragEvent) => { event.preventDefault(); setOver(false); void add(Array.from(event.dataTransfer.files)); },
  };
  return {
    pictures, note, zone, clear, full: pictures.length >= MAX_PICTURES,
    /** For the request: without the page's own preview address. */
    payload: () => pictures.map(({ name, mediaType, data }) => ({ name, mediaType, data })),
    choose: () => chooser.current?.click(),
    /** The hidden file chooser, and the pictures added so far with a way to take each out again. `mark` names them as the models will. */
    view: (mark?: (index: number) => string) => <>
      <input ref={chooser} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => { void add(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      {pictures.length > 0 && <ul className="tp-pictures">{pictures.map((picture, index) => <li key={picture.id}>
        <img src={picture.url} alt={ui("Picture {0}", { 0: String(index + 1) })} />{mark && <span>{mark(index)}</span>}
        <button type="button" aria-label={ui("Remove picture {0}", { 0: String(index + 1) })} title={ui("Remove")} onClick={() => remove(picture.id)}>×</button>
      </li>)}</ul>}
      {note && <p className="tp-error" role="alert">{note}</p>}
    </>,
  };
}
