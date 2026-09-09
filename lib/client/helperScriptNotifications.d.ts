import type { HelperScriptTarget } from '../core/helperScripts.js';
export declare function watchHelperScripts(sessionId: string, storyId: string, listener: () => void): () => void;
export declare function notifyHelperScripts(sessionId: string, storyId: string): void;
export declare function watchHelperScriptAssets(listener: (target: HelperScriptTarget) => void): () => void;
export declare function notifyHelperScriptAssets(target: HelperScriptTarget): void;
