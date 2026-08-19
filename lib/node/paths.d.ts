export interface TavernPaths {
    root: string;
    characters: string;
    lorebooks: string;
    presets: string;
    personas: string;
    regexDir: string;
    sessions: string;
}
export declare function tavernPaths(home?: string): TavernPaths;
export declare function ensurePaths(paths: TavernPaths): Promise<void>;
/** 会话绑定文件名安全化。 */
export declare function sessionFile(paths: TavernPaths, sessionId: string): string;
