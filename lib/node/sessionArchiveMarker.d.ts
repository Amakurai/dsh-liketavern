import type { TavernPaths } from './paths.js';
export declare function sessionArchiveMarkerPath(paths: TavernPaths, sessionId: string): string;
export declare function assertSessionImportComplete(paths: TavernPaths, sessionId: string): Promise<void>;
