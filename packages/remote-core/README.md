# Remote machine core

Private build-time code for the plugins that work on SSH machines, `dsh-remote-agents` and `dsh-remote-terminals`:

- the saved-host and task types and their validation (`domain`), the SSH transport (`ssh`), `~/.ssh/config` reading (`ssh-config`), the plugin's directory and identity on a host (`remote-host`);
- which machine and remote directory a local workspace path stands for (`access`), the workspace contracts (`workspace`) and upload helpers (`transfer`, `staging`);
- what the CLIs report about usage (`usage`) and the Codex handshake (`codex`);
- the narrow access to DSH's permissions and tool registry (`dsh-host`);
- **`machines`: the contract of the service `remoteAgentsMachines`**, which Remote Agents provides and Remote Terminals works through, and `saved-hosts`, which reads the saved machines in a process that is neither;
- `client/`: the few things both pages need — the conversation's current model, a mutation filter, and the hand-over of the "From a project" tab between the two bundles.

It is not published. A plugin lists it under `devDependencies` and imports `@dsh-plugins/remote-core/<file>.js`:

- The client bundle includes what it imports, as with `@dsh-plugins/i18n`.
- The server build compiles this package into the plugin's own `lib/server/core/`, then
  `scripts/link-remote-core.mjs` turns the package imports in `lib/server` into relative ones. The installed plugin
  therefore has no dependency on this package.

```json
"build": "tsc -p ../remote-core/tsconfig.build.json --outDir lib/server/core && tsc -p tsconfig.build.json && node ../../scripts/link-remote-core.mjs"
```

The plugin's `tsconfig.build.json` points the package at that output, so the plugin's own compile stays inside its `src`:

```json
"paths": { "@dsh-plugins/remote-core/*": ["./lib/server/core/*"] }
```

Only code lives here. State stays with the plugin that owns it: two plugins in one DSH each get their own copy of these
modules, so a connection pool or a registry file must be reached through a service of the plugin that opened it.

The tests for these files are in `packages/remote-agents/test` and `packages/remote-terminals/test`.
