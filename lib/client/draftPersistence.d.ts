import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { TavernRemote } from './types.js';
/** 分区独立入口可复用；设置面板内的分区共用父级快照，保留页签与所选角色/剧情。 */
export declare function PersistentEditor(props: {
    remote?: TavernRemote;
    scope: string;
    children: ReactNode;
}): import("react").JSX.Element;
/** 可动态切换字段键；切换角色/剧情时不会带入上一对象的 React state。 */
export declare function useDraftState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>];
/** 恢复标志固定在当前实例；异步资产加载只在第一次跳过草稿，保存后的刷新正常回填。 */
export declare function useDraftRestored(key: string): boolean;
export declare function usePersistentDraftStatus(id: string, dirty: boolean, busy: boolean): (() => void) | undefined;
