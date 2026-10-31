import type { Context } from '@deepseek-ai/cordis';
import { TavernState } from './state.js';
/** 导入失败后保留绑定到归档摘要的回执；相同文件可重试，不能借回执覆盖其它会话。 */
export declare function importSessionArchive(ctx: Context, state: TavernState, input: unknown, workspaceId: string): Promise<{
    sessionId: string;
}>;
