export const itemKey = (item) => `${item.source}:${item.id}`;
export const SOURCE_ID = /^[a-z][a-z0-9-]{0,30}$/u;
export const SENSITIVE_LABELS = ['security', 'payment', 'auth', 'migration', 'prod-incident'];
export const defaultSettings = () => ({
    routes: [],
    run: { denyLabels: [...SENSITIVE_LABELS], permission: 'workspace-write', rounds: 3, flowModels: {}, checkRetries: 1, relay: false },
});
export const say = (key, values, detail) => ({ key, ...(values ? { values } : {}), ...(detail ? { detail } : {}) });
export const render = (message) => message.key.replace(/\{(\w+)\}/gu, (whole, name) => message.values?.[name] ?? whole) + (message.detail ? `\n${message.detail}` : '');
/** An error that knows how to be said in another language. */
export class Failure extends Error {
    said;
    constructor(said) {
        super(render(said));
        this.said = said;
    }
}
export const fail = (key, values, detail) => new Failure(say(key, values, detail));
export const messageOf = (error) => error instanceof Failure ? error.said : say(error instanceof Error ? error.message : String(error));
export const ACTIVE = ['preparing', 'working', 'checking', 'accepting'];
const str = (value, what, max = 2000) => {
    if (typeof value !== 'string' || value.length > max)
        throw new Error(`${what} must be text of at most ${max} characters`);
    return value.trim();
};
const list = (value, what, max = 100) => {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > max)
        throw new Error(`${what} must be a list of at most ${max} entries`);
    return [...new Set(value.map(entry => str(entry, what)).filter(Boolean))];
};
const record = (value, what) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${what} is missing`);
    return value;
};
const whole = (value, what, min, max, fallback) => {
    if (value === undefined)
        return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
        throw new Error(`${what} must be a whole number from ${min} to ${max}`);
    return value;
};
/** A path inside a repository: relative, forward slashes, no way out. */
const repoPath = (value, what) => {
    const path = value.replace(/\\/gu, '/').replace(/^\.\/+/u, '').replace(/\/+$/u, '');
    if (!path || path.startsWith('/') || path.split('/').includes('..'))
        throw fail(`${what} must be a path inside the repository`);
    return path;
};
const PERMISSIONS = ['workspace-write', 'auto', 'danger-full-access'];
/** Settings as a person typed them, checked; throws what to fix. */
export function settingsFrom(raw) {
    const input = record(raw, 'Settings'), base = defaultSettings();
    const ids = new Set();
    const routes = (Array.isArray(input.routes) ? input.routes : []).slice(0, 100).map((entry, index) => {
        const route = record(entry, `Repository ${index + 1}`), name = str(route.name, 'Repository name', 100), id = str(route.id ?? '', 'Repository ID', 100) || name;
        if (!name)
            throw fail('Repository {index} needs a name', { index: String(index + 1) });
        if (ids.has(id))
            throw fail('Two repositories are called {name}', { name: id });
        ids.add(id);
        const project = str(route.project, 'Project', 4096);
        if (!project)
            throw fail('{name}: choose the project it lives in', { name });
        return {
            id, name, project,
            defaultBranch: str(route.defaultBranch ?? '', 'Default branch', 200),
            tests: list(route.tests, 'Test commands', 20),
            packageGlobs: list(route.packageGlobs, 'Package folders', 20).map(glob => repoPath(glob, 'A package folder')),
            sharedPaths: list(route.sharedPaths, 'Shared paths', 50).map(path => repoPath(path, 'A shared path')),
            buildScripts: list(route.buildScripts, 'Build scripts', 10),
            preview: str(route.preview ?? '', 'Preview command'),
            pushRemote: str(route.pushRemote ?? '', 'Remote', 100) || 'origin',
            accept: route.accept === 'push-branch' ? 'push-branch' : 'merge',
        };
    });
    const run = record(input.run ?? {}, 'Run settings'), model = run.model === undefined || run.model === null ? undefined : record(run.model, 'Model');
    const flowModels = record(run.flowModels ?? {}, 'Flow models');
    return {
        routes,
        run: {
            denyLabels: list(run.denyLabels ?? base.run.denyLabels, 'Labels to skip', 50),
            ...(model ? { model: { provider: str(model.provider, 'Model provider', 200), model: str(model.model, 'Model', 500), ...(model.reasoningEffort ? { reasoningEffort: str(model.reasoningEffort, 'Thinking level', 50) } : {}) } } : {}),
            permission: PERMISSIONS.find(value => value === run.permission) ?? base.run.permission,
            rounds: whole(run.rounds, 'Review rounds', 1, 5, base.run.rounds),
            flowModels: Object.fromEntries(['plan', 'implement', 'review'].flatMap(role => typeof flowModels[role] === 'string' && flowModels[role].trim() ? [[role, str(flowModels[role], 'A flow model', 300)]] : [])),
            checkRetries: whole(run.checkRetries, 'Check retries', 0, 5, base.run.checkRetries),
            relay: run.relay === true,
        },
    };
}
/** An item as a source plugin handed it over, checked: another plugin's data is not trusted to have the right shape. */
export function itemFrom(raw, source) {
    const input = record(raw, 'A bug'), id = str(input.id, 'A bug\'s ID', 200), title = str(input.title, 'A bug\'s title', 500);
    if (!id || !title)
        throw new Error('A bug needs an ID and a title');
    const text = (value, what, max) => value === undefined || value === null ? '' : str(value, what, max);
    const project = input.project && typeof input.project === 'object' ? record(input.project, 'A bug\'s project') : undefined;
    const url = text(input.url, 'A bug\'s link', 2000), status = text(input.status, 'A bug\'s status', 100), priority = text(input.priority, 'A bug\'s priority', 100), module = text(input.module, 'A bug\'s module', 200);
    const images = typeof input.images === 'number' && Number.isSafeInteger(input.images) && input.images > 0 ? Math.min(input.images, 100) : 0;
    return {
        source, id, ref: text(input.ref, 'A bug\'s short name', 100) || id, title,
        body: typeof input.body === 'string' ? input.body.slice(0, 200_000) : '',
        ...(/^https?:\/\//u.test(url) ? { url } : {}),
        ...(project && str(String(project.id ?? ''), 'A project ID', 200) ? { project: { id: str(String(project.id), 'A project ID', 200), name: text(project.name, 'A project name', 200) || String(project.id) } } : {}),
        ...(status ? { status } : {}), ...(priority ? { priority } : {}), ...(module ? { module } : {}),
        labels: list(input.labels, 'A bug\'s labels', 50),
        ...(images ? { images } : {}),
    };
}
