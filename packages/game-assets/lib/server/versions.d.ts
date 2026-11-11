/** Folders that are versions of one another, such as `cast-v5`, `cast-v9` and `cast-v9-pilot` beside each other. */
import type { Asset, VersionFamily } from './domain.js';
export interface VersionedFolder {
    name: string;
    version: string;
    label: string;
}
export declare function versionOf(segment: string): VersionedFolder | undefined;
/**
 * Groups images by the outermost versioned folder on their path and sets `family` and `version` on those whose folder has
 * at least one sibling version. Families list their versions oldest first.
 */
export declare function groupVersions(assets: Asset[]): VersionFamily[];
