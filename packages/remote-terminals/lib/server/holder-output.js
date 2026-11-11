/**
 * Live clients must not wait for the holder's headless terminal to parse output. A joining client does need that screen:
 * hold only its subsequent frames until the parser reaches the snapshot barrier, then send snapshot + held frames.
 * Frames are shared (not copied per client); the caller's parser high-water mark bounds this catch-up queue as well.
 */
export class HolderOutput {
    send;
    targets = new Map();
    constructor(send) {
        this.send = send;
    }
    /** The very first client starts with an empty screen and needs no snapshot. */
    add(client) { this.targets.set(client, null); }
    remove(client) { this.targets.delete(client); }
    /** Called before queuing these bytes for headless parsing. Do not debounce or wait for a rendered frame. */
    write(frame) {
        for (const [client, pending] of this.targets) {
            if (pending)
                pending.push(frame);
            else
                this.send(client, frame);
        }
    }
    /**
     * The barrier must run its callback after all previously queued bytes, but before any subsequently queued bytes parse.
     * A disconnect or a second hello invalidates the old callback, including its snapshot/resize work.
     */
    replay(client, barrier, snapshot, connected) {
        const pending = [];
        this.targets.set(client, pending);
        barrier(() => {
            if (this.targets.get(client) !== pending)
                return;
            this.send(client, snapshot());
            for (const frame of pending)
                this.send(client, frame);
            this.targets.set(client, null);
            connected();
        });
    }
}
