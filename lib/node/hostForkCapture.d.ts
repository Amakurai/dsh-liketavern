import type { Context } from '@deepseek-ai/cordis';
import type { TavernPaths } from './paths.js';
interface HostMethods {
    fork(request: unknown): unknown;
}
interface AgentMethods {
    create(options: unknown): unknown;
}
/** 只包装当前服务实例；并发分支各用独立异步上下文，来源仅记录在插件状态中。 */
export declare function captureHostForkRequests(controller: HostMethods, agents: AgentMethods, sourceIsTavern: (id: string) => boolean, saveIdentity: (childId: string, parentId: string, prefix: readonly unknown[]) => Promise<void>): () => void;
/** sessionController 可晚于插件出现或替换；注入子作用域负责安装与卸载。 */
export declare function installHostForkCapture(ctx: Context, paths: TavernPaths): void;
export {};
