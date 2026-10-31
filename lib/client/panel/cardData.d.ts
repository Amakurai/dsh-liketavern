import type { HelperSnapshot } from '../../core/helperRuntime.js';
import type { TavernRemote } from '../types.js';
import { type SessionsPort } from '../openChild.js';
export declare function CardDataSettings({ remote, sessions }: {
    remote: TavernRemote;
    sessions?: SessionsPort;
}): import("react").JSX.Element;
/** 导出当前选中剧情；导入必须选择现有工作区并先确认，失败保留文件以便重试。 */
export declare function SessionTransfer({ remote, sessions, sessionId }: {
    remote: TavernRemote;
    sessions?: SessionsPort;
    sessionId?: string;
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
