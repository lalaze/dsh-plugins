/** Pure detached-replay adapter for the released image/offload record. Mirrors
 * dsh-compaction-image-offload 0.2.2-rc.1; importing history installs no recovery
 * listener and executes no model/tool. Live sessions use the HOST's projection. */
export declare const nativeImageProjection: {
    type: "image/offload";
    project(event: any, context: any): Map<number, any>;
};
