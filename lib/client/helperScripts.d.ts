import type { TavernRemote } from './types.js';
export declare function HelperScripts(props: {
    remote: TavernRemote;
    sessionId: string;
    sessions?: {
        open(id: string): void;
        refresh?: () => Promise<void>;
    };
    onCancel?: () => Promise<void>;
}): import("react").JSX.Element;
