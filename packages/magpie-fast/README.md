# GPT Fast lightning toggle

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

`dsh-magpie-fast` adds a lightning button to the composer toolbar, after permissions and before the task list. It appears only when the selected model is GPT. Turn it on to send subsequent GPT requests in that session with `service_tier: "priority"`; click again to turn it off.

The plugin uses the existing provider, model ID, endpoint, credentials and reasoning selection. It adds no provider and does not modify Magpie configuration. Supported routes are existing custom OpenAI Chat Completions / Responses providers configured in dsh's pi-ai adapter, including remote Magpie. GPT models provided by a CLI subprocess or an unsupported route show a disabled button with an explanation. IDs must be `gpt-*` or `provider/gpt-*`; arbitrary aliases and routing-group contents are not inferred.

## Install

Requires Node.js ≥ 22.19 and DSH `>=0.2.1-rc.2 <0.3.0`. Build the archive on the target machine, from the workspace root:

```sh
pnpm install --frozen-lockfile
pnpm --filter dsh-magpie-fast pack:plugin
```

For Desktop, fully quit DSH and use the desktop application's bundled `dsh` command from the workspace root, then reopen the app:

```sh
dsh plugin --profile desktop add "$PWD/dist/dsh-magpie-fast-0.1.1.tgz"
```

The standalone npm CLI cannot manage the reserved `desktop` profile. Alternatively, enter the archive's absolute path in Desktop's Settings → Plugins → Add plugin → Install third-party plugin, then restart. Web users can install the same archive with `--profile web`, restart that profile and refresh the browser.

Select your original GPT model and click the lightning button. Remote Magpie uses the gateway key already configured on that provider.

Since `0.1.1`, the plugin resolves the OpenAI implementation already owned by DSH's `dsh-llm-pi-ai` adapter. The archive no longer depends on the complete `pi-ai` package, so installing it does not add Google SDK, `protobufjs`, or build-script approvals for those packages. The source retains `pi-ai` as a development dependency for type checking only.

## Behavior and configuration

Fast starts off. A lit button means the preference was saved; a failed write keeps the previous state and reports an error. Preferences are per session and survive reloads and restarts. Switching to a non-GPT model hides the button; returning to GPT restores the preference. Changes affect the next model request, while an active request retains its captured endpoint, credentials and fast setting. Auxiliary GPT calls carrying that session ID also follow the preference.

Disabled fast, non-GPT models, unsupported routes and calls without a session ID keep their original dispatch path. The fast path uses dsh's own file/image/tool projections, pi-ai conversion, streaming, usage and replay machinery. No global fetch patch or model-selector replacement is installed.

The bundle inserts the plugin automatically. Optional overrides in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-magpie-fast
  config:
    defaultEnabled: false
    # stateDir: /your/private/state/directory
```

`defaultEnabled` applies to sessions without an explicit preference. Preferences live in `${DSH_HOME:-~/.dsh}/storages/dsh-magpie-fast/preferences.json`. Only session IDs and booleans are stored; writes are serialized, atomic and mode `0600`. The most recently set 10,000 sessions are retained. Use a separate state directory for each DSH process; cross-process concurrent writes are unsupported.

Source connection details are read from Host settings and remain on the Host. Credential resolution reuses the source's `apiKeyEnv`, pi-ai API-key record or explicit Authorization header. Fast requests priority processing; the actual tier and charges/quota depend on the upstream. Magpie's `tier_sent` and `tier_served` distinguish what was sent from what the vendor reported serving.

## Development

```sh
pnpm --filter dsh-magpie-fast check
pnpm --filter dsh-magpie-fast test:ui
pnpm --filter dsh-magpie-fast preview:ui
```

The demo binds to `0.0.0.0` and opens at `http://100.96.195.115:4184/`. It uses fixture data.

`check` also installs the actual archive offline into an empty profile with strict dependency-build policy, verifies that no complete `pi-ai`, Google SDK or `protobufjs` is added, then exercises both priority-enabled wire protocols from the installed archive using only host-owned implementations.

Automated tests also cover reasoning, tools, usage/replay, session isolation, persistence/reload failures, unchanged provider registration, and the real UI component's keyboard, theme and narrow-screen behavior. No tests call a paid model or prove that an upstream actually granted priority service.

MIT.
