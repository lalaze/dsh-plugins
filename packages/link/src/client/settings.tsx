/** Settings → DSH Link: this machine's listener, every machine found, notifications, restart. */
import React, { useEffect, useState } from 'react';
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { ui, useLocale } from './i18n.js';
import { openMachine } from './navigate.js';
import { askPermission, notificationPermission, notifyPref, setNotifyPref, type NotifyPref } from './notify.js';
import { RestartDialog } from './restart.js';
import { keepPages, limitedConnections, setKeepPages } from './shell.js';
import { loadMachines, onScreen, SELF, useStore } from './store.js';
import { dotOf, since, summaryOf } from './view.js';

export function SettingsSection() {
  useLocale();
  const answer = useStore(state => state.answer);
  const error = useStore(state => state.error);
  const attention = useStore(state => state.attention);
  const [pref, setPref] = useState<NotifyPref>(notifyPref());
  const [permission, setPermission] = useState(notificationPermission());
  const [restarting, setRestarting] = useState(false);
  const [keep, setKeep] = useState(keepPages());
  useEffect(() => {
    void loadMachines();
    const timer = setInterval(() => void loadMachines(), 10_000);
    return () => clearInterval(timer);
  }, []);
  const self = answer?.self;
  const current = onScreen();
  const choose = (value: NotifyPref) => { setPref(value); setNotifyPref(value); };

  return <div className="dl-settings">
    <h3>{ui('This computer')}</h3>
    <div className="dl-card">
      {!answer && !error && <span className="dl-muted">{ui('Loading…')}</span>}
      {error && <span className="dl-error">{error}</span>}
      {self && <>
        <div className="dl-line"><strong>{self.name}</strong><span className="dl-muted">{self.os} · dsh-link {self.version}</span></div>
        <div className="dl-line">
          <span className="dl-label">{ui('Tailscale')}</span>
          <span>{self.tailnet.running ? self.tailnet.address ?? ui('Connected') : self.tailnet.error ? <span className="dl-error">{self.tailnet.error}</span> : ui('Not connected')}</span>
        </div>
        <div className="dl-line">
          <span className="dl-label">{ui('Open to other machines')}</span>
          <span>{self.url ? <code>{self.url}</code> : self.listenError ? <span className="dl-error">{self.listenError}</span> : <span className="dl-muted">{ui('Not listening')}</span>}</span>
        </div>
        {current !== SELF && <p className="dl-muted">{ui('This page shows another machine; the list below is the one of the computer serving it.')}</p>}
      </>}
    </div>

    <h3>{ui('Machines')}</h3>
    {answer && answer.machines.length === 0 && <div className="dl-empty">{ui('No other machine yet. Install this plugin in the DSH of your other computers on the same Tailscale account, or add an address in the plugin settings.')}</div>}
    {answer && answer.machines.length > 0 && <div className="dl-card dl-machines">
      {answer.machines.map(machine => <div className="dl-machine" key={machine.id}>
        <StateDot state={dotOf(machine, attention[machine.id])} size={8} />
        <div className="dl-machine-text">
          <strong>{machine.name}</strong>
          <span className="dl-muted">{summaryOf(machine, attention[machine.id], false)} · <code>{machine.url}</code>{machine.version ? ` · ${machine.version}` : ''}{machine.state === 'online' && machine.lastSeen ? '' : machine.lastSeen ? ` · ${since(machine.lastSeen)}` : ''}</span>
        </div>
        <Button size="sm" variant="outline" disabled={machine.state !== 'online' || machine.id === current} onClick={() => openMachine(machine.id)}>{machine.id === current ? ui('Shown') : ui('Open')}</Button>
      </div>)}
    </div>}

    <h3>{ui('Switching')}</h3>
    <div className="dl-card">
      <label className="dl-check"><input type="checkbox" checked={keep} onChange={event => { setKeep(event.target.checked); setKeepPages(event.target.checked); }} /> {ui('Keep machines\' pages open in this window')}</label>
      <span className="dl-muted">{ui('Switching back to a machine is then instant and keeps where you were; each open machine uses memory like another tab. Off: each switch loads the machine\'s page again.')}</span>
      {limitedConnections() && <span className="dl-muted">{ui('This page reaches DSH over HTTP/1.1, which allows only a few connections at once; with several machines open, pages can stall. Off unless you turn it on here.')}</span>}
    </div>

    <h3>{ui('Notifications')}</h3>
    <div className="dl-card">
      <div className="dl-choices" role="radiogroup" aria-label={ui('Notifications')}>
        {([['all', ui('Waiting and finished')], ['waiting', ui('Only when waiting for me')], ['off', ui('Off')]] as const).map(([value, label]) =>
          <label key={value}><input type="radio" name="dl-notify" checked={pref === value} onChange={() => choose(value)} /> {label}</label>)}
      </div>
      <span className="dl-muted">{ui('Other machines\' notices show in this page; system notifications are for when it is not in front.')}</span>
      {pref !== 'off' && permission === 'default' && <Button size="sm" variant="outline" onClick={() => void askPermission().then(setPermission)}>{ui('Allow notifications in this browser')}</Button>}
      {pref !== 'off' && permission === 'denied' && <span className="dl-muted">{ui('This browser blocks system notifications for this site; the notices in the page still show.')}</span>}
      {pref !== 'off' && permission === 'unsupported' && <span className="dl-muted">{ui('This browser cannot show system notifications; the notices in the page still show.')}</span>}
    </div>

    <h3>{ui('Restart')}</h3>
    <div className="dl-card">
      <span className="dl-muted">{ui('Quits DSH cleanly and starts it again, also when you are connected from another machine.')}</span>
      <div><Button size="sm" variant="outline" onClick={() => setRestarting(true)}>{ui('Restart DSH…')}</Button></div>
    </div>
    <p className="dl-muted">{ui('Name, port and machines added by address are in Plugins → DSH Link.')}</p>
    <RestartDialog open={restarting} onClose={() => setRestarting(false)} name={current === SELF ? self?.name ?? ui('This computer') : answer?.machines.find(machine => machine.id === current)?.name ?? ''} />
  </div>;
}
