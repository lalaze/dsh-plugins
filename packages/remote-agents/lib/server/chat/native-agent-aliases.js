/** Public scoped tool registrations. Only these released control tools own a
 * top-level `agent_id`; arbitrary arguments/history/message strings stay exact.
 * Calling the original definition preserves native adjacency and authorization. */
const bindings = new WeakMap();
export function installNativeAgentAliases(agent, aliases, admit) {
    // Agent event carriers may be scope proxies; their attached Session is the
    // canonical lifetime identity shared with agents.get()/the controller.
    const key = agent.session;
    const existing = bindings.get(key);
    if (existing) {
        Object.assign(existing, aliases);
        return;
    }
    const currentAliases = { ...aliases };
    bindings.set(key, currentAliases);
    agent.ctx.inject(['tools'], (scope) => {
        for (const name of ['send_message', 'interrupt_agent']) {
            const original = scope.tools.get(name, agent);
            if (!original)
                continue;
            const descriptors = Object.getOwnPropertyDescriptors(original);
            delete descriptors.execute;
            const definition = Object.create(Object.getPrototypeOf(original), descriptors);
            Object.defineProperty(definition, 'execute', { enumerable: true, configurable: true, writable: true,
                value: async (args, exec) => {
                    await admit(exec.agent?.id ?? agent.id);
                    const target = typeof args.agent_id === 'string' && Object.hasOwn(currentAliases, args.agent_id) ? currentAliases[args.agent_id] : args.agent_id;
                    return original.execute.call(original, target === args.agent_id ? args : { ...args, agent_id: target }, exec);
                } });
            scope.tools.register(definition);
        }
    });
}
