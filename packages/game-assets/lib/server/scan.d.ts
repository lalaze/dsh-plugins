import { type FolderRule, type ScannedAsset, type ScanResult } from './domain.js';
/** Code and data files larger than this are not read for references. */
export declare const TEXT_LIMIT: number;
export type Rules = Record<string, FolderRule>;
export declare class Scanner {
    /** Sizes and hashes of files unchanged since an earlier scan, by absolute path. */
    private readonly measured;
    private measure;
    /** Marks byte-identical files with a shared number. Only files of equal size are read. */
    private markDuplicates;
    /**
     * `root` is an existing directory; `rules` name the top-level folders the user switched on or off. Images under
     * `retireDir` are listed as retired whatever the rules say, and nothing in that folder counts as code.
     */
    scan(root: string, rules?: Rules, retireDir?: string): Promise<ScanResult<ScannedAsset>>;
}
