/** Pure detached-replay adapter for the released image/offload record. Mirrors
 * dsh-compaction-image-offload 0.2.2-rc.1; importing history installs no recovery
 * listener and executes no model/tool. Live sessions use the HOST's projection. */
export const nativeImageProjection = {
    type: 'image/offload',
    project(event, context) {
        const bad = () => { throw new Error('Invalid native image/offload projection'); };
        const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
        const index = (value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
        const data = event.data;
        if (!record(data) || Object.keys(data).length !== 1 || !Array.isArray(data.targets) || !data.targets.length)
            bad();
        const nodes = new Set(context.nodes), messages = new Map();
        for (const target of data.targets) {
            if (!record(target) || Object.keys(target).length !== 2 || !index(target.seq) || !Array.isArray(target.imageIndexes) || !target.imageIndexes.length)
                bad();
            if (!nodes.has(target.seq) || messages.has(target.seq))
                bad();
            const source = context.events[target.seq - context.baseSeq];
            if (source?.type !== 'user/message' && source?.type !== 'tool/result')
                bad();
            let previous = -1;
            for (const i of target.imageIndexes) {
                if (!index(i) || i <= previous)
                    bad();
                previous = i;
            }
            const message = context.messages.get(target.seq) ?? (source.type === 'user/message' ? source.data : source.data.message);
            let current = 0, selected = 0;
            const content = message.content.map((block) => {
                if (block.type !== 'image')
                    return block;
                const take = current++ === target.imageIndexes[selected];
                if (!take)
                    return block;
                if (block.offloaded === true)
                    bad();
                selected++;
                return { ...block, offloaded: true };
            });
            if (selected !== target.imageIndexes.length)
                bad();
            messages.set(target.seq, { ...message, content });
        }
        return messages;
    },
};
