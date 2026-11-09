import type { NativeHost, NativeSharing } from './native-service.js';
import { type NativeAutonomyHost } from './native-autonomy.js';
/** Concrete public-service binding. Capturing/importing never creates Agents,
 * goals, schedules, tools or model requests. All activation is explicit. */
export declare function nativeRuntimeAutonomy(get: (name: string) => any, load: (name: string) => Promise<any>, host: NativeHost, sharing: NativeSharing): NativeAutonomyHost;
