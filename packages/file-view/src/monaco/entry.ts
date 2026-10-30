// The editor bundle a plugin serves and loads on demand: VS Code's editor (Monaco) with its contributions, every
// language it highlights and JSON's language service. CSS, HTML and TypeScript keep their highlighting but not their
// language services, whose workers would add several megabytes and could not see the workspace's dependencies anyway.
// The locale module must come first: Monaco reads its messages as its modules load.
import './locale.js';
import * as monaco from 'monaco-editor';
import editorWorker from 'dsh-worker:editor';
import jsonWorker from 'dsh-worker:json';

const urls = new Map<string, string>();
const workerUrl = (name: string, source: string) => {
  let url = urls.get(name);
  if (!url) { url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' })); urls.set(name, url); }
  return url;
};
(globalThis as { MonacoEnvironment?: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id: string, label: string) => label === 'json' ? new Worker(workerUrl('json', jsonWorker), { name: label }) : new Worker(workerUrl('editor', editorWorker), { name: label }),
};
// Workspaces hold JSON with comments (tsconfig.json, .vscode settings) more often than strict JSON, and no schemas are fetched.
monaco.json.jsonDefaults.setDiagnosticsOptions({ validate: true, allowComments: true, comments: 'ignore', trailingCommas: 'warning', enableSchemaRequest: false });
export * from 'monaco-editor';
