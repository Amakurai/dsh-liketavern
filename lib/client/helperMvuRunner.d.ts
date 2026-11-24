import type { HelperSnapshot } from '../core/helperRuntime.js';
import type { TavernRemote } from './types.js';
export interface HelperMvuRunnerStatus {
    error: string | null;
    busy: boolean;
    restartRequired: boolean;
    canCancel: boolean;
    canceling: boolean;
    cancelError: string | null;
    retry: () => void;
    cancel?: () => Promise<void>;
}
export declare function HelperMvuRunner(props: {
    remote: TavernRemote;
    sessionId: string;
    storyId: string;
    snapshot: HelperSnapshot;
    ready: boolean;
    onStatus?: (status: HelperMvuRunnerStatus) => void;
    onCancel?: () => Promise<void>;
}): import("react").JSX.Element;
