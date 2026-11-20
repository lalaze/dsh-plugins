/**
 * One field of the status while the user edits it in place. There is no edit mode and no Save button: the text is saved a
 * moment after the typing stops, when the field is left, and at once for a tick of a box. Agents write the same file
 * meanwhile, so each save names the text the edit began from, and when the host has another by then the user's text is
 * kept and they choose between the two.
 */
import { useEffect, useReducer, useRef } from 'react';
import type { Field } from '../domain.js';
import { tidy } from '../status-file.js';
import { saveField, StatusRequestError } from './api.js';
import { activeLocale, localizeError } from './i18n.js';
import { put, refresh } from './status.js';

/** How long after the last keystroke a text is saved. */
export const TYPING_MS = 1200;
/** How long "Saved" stays up. */
const SAVED_MS = 2000;

export interface FieldEdit {
  /** What to show: the user's text while they have one, the host's otherwise. */
  value: string;
  saving: boolean;
  /** A save went through a moment ago. */
  saved: boolean;
  /** Why the last save failed, in the page's language. */
  failure: string;
  /** The host's text, when it changed under the user's own. */
  theirs?: string;
  /** The user's text for now; it is saved once the typing stops. */
  type(value: string): void;
  /** Saves now: the given text, or what was typed. */
  commit(value?: string): void;
  /** Whether the user is in the field; their text stays as typed until they leave it. */
  hold(held: boolean): void;
  /** Settles a change from elsewhere: drop the user's text, or put it over the host's. */
  takeTheirs(): void;
  keepMine(): void;
}

interface Box { draft?: string; base: string; server: string; want?: string; saving: boolean; held: boolean; failure: string; saved: boolean; timer?: ReturnType<typeof setTimeout>; flash?: ReturnType<typeof setTimeout>; gone: boolean }

/** @param server - the field's text as the host last answered it. A component is for one conversation; key it by the session. */
export function useField(sessionId: string, field: Field, server: string): FieldEdit {
  const [, render] = useReducer((count: number) => count + 1, 0);
  const box = useRef<Box>({ base: server, server, saving: false, held: false, failure: '', saved: false, gone: false }).current;
  box.server = server;
  // With no text of the user's the edit begins from whatever the host says; so it does once the host says what they typed.
  if (!box.saving && (box.draft === undefined || tidy(box.draft) === server)) box.base = server;
  const theirs = box.draft !== undefined && !box.saving && server !== box.base ? server : undefined;

  const run = async () => {
    if (box.saving) return;
    box.saving = true; box.failure = '';
    render();
    try {
      while (box.want !== undefined) {
        const target = box.want;
        if (tidy(target) !== box.base) {
          const answer = await saveField(sessionId, field, target, box.base, activeLocale());
          box.base = answer.fields[field];
          put(sessionId, answer);
          box.saved = true;
          clearTimeout(box.flash);
          box.flash = setTimeout(() => { box.saved = false; if (!box.gone) render(); }, SAVED_MS);
        }
        if (box.want === target) box.want = undefined;
      }
      // Saved and not being typed in: the host's text is the one to show again.
      if (!box.held && box.draft !== undefined && tidy(box.draft) === box.base) box.draft = undefined;
    } catch (problem) {
      box.want = undefined;
      // Someone wrote the field meanwhile: the new text arrives, and the user's stays beside it.
      if (problem instanceof StatusRequestError && problem.status === 409) await refresh(sessionId);
      else box.failure = localizeError(problem);
    } finally {
      box.saving = false;
      if (!box.gone) render();
    }
  };
  const commit = (value?: string) => {
    clearTimeout(box.timer); box.timer = undefined;
    if (value !== undefined) box.draft = value;
    if (box.draft === undefined) return;
    // A change from elsewhere that the user has not settled yet: saving would only be refused again.
    if (box.server !== box.base && tidy(box.draft) !== box.server) return;
    box.want = box.draft;
    void run();
  };
  // Leaving the view with something typed saves it; the save finishes without the view.
  useEffect(() => {
    box.gone = false;
    return () => {
      if (box.timer !== undefined) commit();
      box.gone = true;
      clearTimeout(box.flash);
    };
  }, []);

  return {
    value: box.draft ?? server, saving: box.saving, saved: box.saved && !box.saving, failure: box.failure, ...(theirs === undefined ? {} : { theirs }),
    type(value) {
      box.draft = value; box.failure = '';
      clearTimeout(box.timer);
      box.timer = setTimeout(() => { box.timer = undefined; commit(); }, TYPING_MS);
      render();
    },
    commit,
    hold(held) { box.held = held; },
    takeTheirs() { clearTimeout(box.timer); box.timer = undefined; box.draft = undefined; box.want = undefined; box.failure = ''; render(); },
    keepMine() { box.base = server; commit(); },
  };
}
