import { useCallback, useEffect, useRef, useState } from 'react';
import { install, offerFor, type Offer, type Outcome, type Remote } from './index.js';

export interface PluginOffer {
  /** Absent while the markets are being asked. */
  offer?: Offer;
  busy: boolean;
  outcome?: Outcome;
  /** Installs or updates what `offer` names; does nothing for any other offer. */
  run(): void;
}
/**
 * What a page can do about a plugin it needs. `remote` is read when it is used, because a page can outlive the
 * service. `settled` is told once an installation ended, so the page can look again at what it has.
 */
export function usePluginOffer(remote: () => Remote | undefined, name: string, settled?: (outcome: Outcome) => void): PluginOffer {
  const [offer, setOffer] = useState<Offer>(), [busy, setBusy] = useState(false), [outcome, setOutcome] = useState<Outcome>();
  const alive = useRef(true), latest = useRef(settled);
  latest.current = settled;
  useEffect(() => {
    alive.current = true;
    setOffer(undefined); setOutcome(undefined);
    void offerFor(remote(), name).then(found => { if (alive.current) setOffer(found); });
    return () => { alive.current = false; };
  }, [name]);
  const run = useCallback(() => {
    if (busy || (offer?.kind !== 'install' && offer?.kind !== 'update')) return;
    setBusy(true); setOutcome(undefined);
    void install(remote(), offer).then(result => {
      latest.current?.(result);
      if (!alive.current) return;
      setBusy(false); setOutcome(result);
    });
  }, [busy, offer]);
  return { offer, busy, outcome, run };
}
