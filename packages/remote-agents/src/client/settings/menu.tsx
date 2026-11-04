import React, { useEffect, useId, useRef, useState } from 'react';
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree';

/** A disclosure caret that rotates when its section is open. */
export function Chevron({ open }: { open: boolean }) {
  return <svg className="ra-chevron" data-open={open} width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" /></svg>;
}

/**
 * A compact "⋯" actions menu matching the session options menu: a click outside or Escape closes it.
 * `children` receives a `close` so an item can act and dismiss the menu in one handler.
 */
export function ActionsMenu({ label, children }: { label: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId(), menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    const keyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); menu.current?.querySelector<HTMLButtonElement>('button')?.focus(); } };
    document.addEventListener('pointerdown', pointer); document.addEventListener('keydown', keyboard, true);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', keyboard, true); };
  }, [open]);
  return <div className="ra-detail-menu" ref={menu}>
    <button type="button" className="ra-icon-button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><DotsThreeIcon size={22} weight="bold" /></button>
    {open && <div className="ra-options-panel ra-menu-panel" id={id} role="menu" aria-label={label}>{children(() => setOpen(false))}</div>}
  </div>;
}
