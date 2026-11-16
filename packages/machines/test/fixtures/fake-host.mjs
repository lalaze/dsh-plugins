// A stand-in for a DSH process in the restart test: marks a restart in progress back, like the plugin does at start,
// and quits on SIGTERM. Usage: node fake-host.mjs <state.json>
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

const [stateFile] = process.argv.slice(2);
setTimeout(() => {
  try {
    const record = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (['armed', 'quitting', 'launching'].includes(record.phase) && record.fromPid !== process.pid) {
      writeFileSync(`${stateFile}.t`, JSON.stringify({ ...record, phase: 'back', toPid: process.pid, backAt: Date.now() }));
      renameSync(`${stateFile}.t`, stateFile);
    }
  } catch { /* no restart */ }
}, 200);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1_000);
