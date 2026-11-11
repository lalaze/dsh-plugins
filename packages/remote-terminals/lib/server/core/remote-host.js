import { createHash } from 'node:crypto';
/** The plugin's private directory on every SSH host: installed scripts, relays and shared state live under it. */
export const REMOTE_HOME = '"$HOME/.dsh-remote-agents"';
/**
 * Shell that prints `<hostname>\0<user>\0<machine id>\0`. Empty machine-id files are readable, so an empty one falls
 * back on the OS name as a read failure does.
 */
export const MACHINE_IDENTITY = `dsh_machine_id="$(cat /etc/machine-id 2>/dev/null)"; if [ -z "$dsh_machine_id" ]; then dsh_machine_id="$(uname -s)"; fi; printf '%s\\0%s\\0%s\\0' "$(uname -n)" "$(id -un)" "$dsh_machine_id"`;
/** The pinned identity of an SSH machine and account, from the fields `MACHINE_IDENTITY` prints. */
export const serverIdOf = (machine, user, unique) => `ssh-${createHash('sha256').update(JSON.stringify([machine, user, unique])).digest('hex')}`;
/**
 * Shell that installs a Node.js script once per version as `REMOTE_HOME/<name>/<name>-<version>.mjs`, creating
 * `directories` private beside it, then runs `after` and prints `ready`. Without Node.js 18 or newer on the login PATH
 * it prints `missing-node` or `old-node` and installs nothing.
 */
export function remoteScript(name, version, script, options = {}) {
    const folder = `${REMOTE_HOME}/${name}`, path = `${folder}/${name}-${version}.mjs`, end = `DSH_${name.toUpperCase()}_SCRIPT_END`;
    const directories = [folder, ...options.directories ?? []].join(' ');
    return { path, install: `command -v node >/dev/null 2>&1 || { printf missing-node; exit 0; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || { printf old-node; exit 0; }
umask 077
mkdir -p ${directories}
chmod 700 ${REMOTE_HOME} ${directories}
if [ ! -f ${path} ]; then
  dsh_${name}_tmp="$(mktemp ${folder}/.${name}.XXXXXXXXXX)"
  cat > "$dsh_${name}_tmp" <<'${end}'
${script}
${end}
  mv -f "$dsh_${name}_tmp" ${path}
fi
${options.after ? `${options.after}\n` : ''}printf ready` };
}
