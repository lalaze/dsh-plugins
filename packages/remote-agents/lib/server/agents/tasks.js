export function remoteTasks(service) {
    const unbound = (task) => !task.chatSessionId;
    const withHost = (agent) => ({ ...agent, host: service.hosts().find(h => h.id === agent.hostId)?.label ?? agent.hostId });
    const task = async (id) => {
        const agent = await service.summary(id);
        if (!unbound(agent))
            throw new Error('This session continues in a DSH conversation; open it there');
        return agent;
    };
    return {
        tasksVersion: 1,
        list: async () => (await service.snapshot()).agents.filter(unbound).map(withHost),
        detail: async (id, cursor, direction) => {
            await task(id);
            const { agent, permissions, timeline } = await service.detail(id, cursor, direction);
            return { task: withHost(agent), permissions, timeline };
        },
        send: async (id, messageId, text) => { await task(id); await service.send(id, { id: messageId, text }); },
        stop: async (id) => { await task(id); await service.stop(id); },
        respond: async (id, requestId, answer) => { await task(id); await service.respond(id, requestId, answer); },
        subscribe: listener => {
            service.store.changeListeners.add(listener);
            return () => { service.store.changeListeners.delete(listener); };
        },
        chatReadMark: sessionId => service.chatReadMark(sessionId),
        markChatRead: sessionId => service.markChatRead(sessionId),
        subscribeChatRead: listener => {
            service.chatReadListeners.add(listener);
            return () => { service.chatReadListeners.delete(listener); };
        },
    };
}
