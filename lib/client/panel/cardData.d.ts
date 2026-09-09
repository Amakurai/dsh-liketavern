import type { HelperSnapshot } from '../../core/helperRuntime.js';
import type { TavernRemote } from '../types.js';
export declare function CardDataSettings({ remote }: {
    remote: TavernRemote;
}): import("react").JSX.Element;
export declare function StoryVariableSettings(props: {
    remote: TavernRemote;
    cardId: string;
    storyId: string;
    sessionId: string;
}): import("react").JSX.Element;
export declare function VariableBackupEditor(props: {
    remote: TavernRemote;
    sessionId: string;
    messageId: number;
    snapshot: HelperSnapshot;
    onRefresh: () => void;
}): import("react").JSX.Element;
