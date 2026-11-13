import { type Aspect, type SourceKind, type SourcesAnswer, type SourceView } from './domain.js';
export interface ImageSource {
    id: string;
    name: string;
    kind: SourceKind;
    baseUrl: string;
    model: string;
    apiKey: string;
}
/** Sources one DSH keeps. */
export declare const SOURCE_LIMIT = 20;
export declare const viewOf: ({ apiKey, ...source }: ImageSource) => SourceView;
/**
 * A source as it may be saved, from what the client sent. A source being edited keeps its saved key unless a new one is
 * given; an empty key is allowed, for a local or relay endpoint that needs none.
 */
export declare function cleanSource(value: unknown, previous?: ImageSource): Omit<ImageSource, 'id'>;
/** The user's image sources, in one JSON file only its owner may read. */
export declare class SourceStore {
    private readonly file;
    private loaded;
    private writing;
    constructor(file: string);
    private load;
    private save;
    private answer;
    list(): Promise<SourcesAnswer>;
    /** The source to generate with: the one named, or else the default. */
    get(id?: unknown): Promise<ImageSource>;
    /** Adds a source, or changes the one with the given `id`. The first source becomes the default. */
    put(value: unknown): Promise<SourcesAnswer & {
        id: string;
    }>;
    remove(id: unknown): Promise<SourcesAnswer>;
    setDefault(id: unknown): Promise<SourcesAnswer>;
}
export interface Reference {
    name: string;
    data: Buffer;
    mediaType: string;
}
export interface GenerateInput {
    prompt: string;
    references: Reference[];
    aspect: Aspect;
    transparent: boolean;
}
export interface Generated {
    data: Buffer;
    mediaType: string;
    width?: number;
    height?: number;
    text?: string;
}
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
/** Image models often take a minute or two; past this a generation is given up. */
export declare const GENERATE_TIMEOUT_MS = 300000;
/** Asks the source for one picture. `signal` stops it, as when the user closes the dialog. */
export declare function generateImage(source: ImageSource, input: GenerateInput, options?: {
    fetch?: Fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<Generated>;
export {};
