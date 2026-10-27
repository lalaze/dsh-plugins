// A DSH process for crash tests: starts one remote agent through the relay and keeps running until killed.
import { join } from 'node:path';
import { SshBackend } from '../../src/backend.js';
import { RemoteAgentsService } from '../../src/service.js';
import { Store } from '../../src/store.js';
import { LocalTransport } from '../relay-harness.js';

const [home, state, hostId, provider, prompt, id] = process.argv.slice(2);
const transport = new LocalTransport(home), store = new Store(join(state, 'state.json')); await store.open();
const service = new RemoteAgentsService(store, host => new SshBackend(host, store, transport));
const agent = await service.create({ id, hostId, cwd: join(home, 'project'), provider, model: 'fake-model', prompt });
process.stdout.write(`${JSON.stringify(agent)}\n`);
setInterval(() => {}, 1000);
