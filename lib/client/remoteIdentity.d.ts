/** 为宿主 remote 分配仅在页面内有效的身份，用于 React 生命周期隔离，不作为业务身份或权限令牌。 */
import type { TavernRemote } from './types.js';
export declare function remoteIdentity(remote: TavernRemote): number;
