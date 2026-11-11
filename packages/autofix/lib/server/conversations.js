/** The parts of DSH a task runs on: a conversation in a workspace, and a model flow inside it. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export class Conversations {
    service;
    /** `service` looks a DSH service up by name at the moment it is needed: plugins load in any order. */
    constructor(service) {
        this.service = service;
    }
    need(name, what) {
        const value = this.service(name);
        if (!value)
            throw new Error(`${what} is not available in this DSH`);
        return value;
    }
    /** A new conversation in the workspace at `path` (an existing folder, or a remote workspace's local anchor). */
    async open(input) {
        const workspaces = this.need('workspaceController', 'Workspaces'), sessions = this.need('sessionController', 'Conversations');
        const workspaceId = String((await workspaces.create({ path: input.path })).workspace.workspaceId);
        const sessionId = String((await sessions.create({ workspaceId })).sessionId);
        if (input.model) {
            const { provider, model, reasoningEffort } = input.model;
            await sessions.selectModel({ sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
        }
        await sessions.rename({ sessionId, title: input.title });
        const session = this.need('sessions', 'Conversations').get(sessionId);
        if (!session)
            throw new Error('DSH did not keep the new conversation open');
        // The steps of a flow take the conversation's permission, and nobody is there to answer a prompt.
        this.need('permissionPresets', 'Permissions').set(session, input.permission);
        return { workspaceId, sessionId };
    }
    /** A picture into DSH's attachment store. Throws when DSH will not take it (too large, not a picture it reads). */
    async picture(image) {
        const mediaType = image.mediaType === 'image/jpg' ? 'image/jpeg' : image.mediaType;
        if (!IMAGE_TYPES.includes(mediaType))
            throw new Error(`DSH does not read ${image.mediaType} pictures`);
        return this.need('attachments', 'Attachments').saveImage({ data: image.data, mediaType, ...(image.name ? { name: image.name } : {}) });
    }
    /** A picture DSH keeps, as its bytes: for handing it to another DSH. */
    async image(ref) {
        const stored = await this.need('attachments', 'Attachments').readImage(ref);
        return { data: stored.data, mediaType: stored.ref.mediaType };
    }
    /** Runs a command line in a conversation, as if it had been typed there. */
    async command(sessionId, line) {
        const commands = this.need('commands', 'Commands');
        const resolved = await this.need('sessionController', 'Conversations').resolveAgent(sessionId);
        if ('error' in resolved)
            throw new Error(`The task's conversation could not be opened: ${resolved.error.message ?? resolved.error.code ?? 'unknown reason'}`);
        await commands.execute(resolved.agent, line, [], new AbortController().signal);
    }
    /** Plan, implement and review in that conversation; resolves once the flow has started. */
    async flow(sessionId, input) {
        const flows = this.need('modelFlow', 'Model flow (the dsh-model-flow plugin, 0.1.7 or newer)');
        const resolved = await this.need('sessionController', 'Conversations').resolveAgent(sessionId);
        if ('error' in resolved)
            throw new Error(`The task's conversation could not be opened: ${resolved.error.message ?? resolved.error.code ?? 'unknown reason'}`);
        return flows.start(resolved.agent, input);
    }
}
