import type { HelperSnapshot } from '../core/helperRuntime.js';
import type { TavernRemote } from './types.js';
export declare function HelperMvuRunner(props: {
    remote: TavernRemote;
    sessionId: string;
    storyId: string;
    snapshot: HelperSnapshot;
    ready: boolean;
    onStatus?: (status: {
        error: string | null;
        busy: boolean;
        retry: () => void;
    }) => void;
    onCancel?: () => Promise<void>;
}): import("react").JSX.Element;
