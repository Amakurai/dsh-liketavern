import type { ClientContext, TavernRemote } from './types.js';
type EventRemote = Pick<TavernRemote, 'getHelperEventState'>;
/** 仅解析当前已保留会话的公开 binding，不调用 open/历史分页；旧宿主没有 binding 时不安装。 */
export declare function installHelperLiveEvents(sessions: ClientContext['sessions'], remote: EventRemote): () => void;
export {};
