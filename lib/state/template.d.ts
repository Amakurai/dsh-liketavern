import { type TemplateScopes } from '../core/template.js';
import { type WITimerState } from '../core/types.js';
import type { WorkspaceFs } from './workspaceFs.js';
import { type TemplateGeneration } from './templateGeneration.js';
import { type TemplateDisplayPart } from '../core/templateDisplay.js';
import { type TemplateMessageVariables } from '../core/templateMessageVariables.js';
import type { TemplateContinuation } from '../core/templateContinuation.js';
export declare const TEMPLATE_STATE_PATH = "state/template.json";
export interface TemplateState {
    version: 1;
    variables: TemplateScopes;
    messageVariables?: TemplateMessageVariables;
    continuation?: TemplateContinuation;
    outputs: Record<string, {
        hash: string;
        text: string;
        parts?: TemplateDisplayPart[];
    }>;
    /** 与生成变量在同一次原子替换中提交；缺字段的旧状态继续读取独立定时文件。 */
    wiTimers?: Record<string, WITimerState>;
    /** 未完成轮的闭包重放与冻结计划；完成后缩成归属回执，防止重启重复执行。 */
    generation?: TemplateGeneration;
}
export declare const templateTextHash: (text: string) => string;
export declare function loadTemplateState(fs: WorkspaceFs): Promise<TemplateState>;
export declare function saveTemplateState(fs: WorkspaceFs, state: TemplateState): Promise<void>;
/** 新状态优先；旧文件保留为迁移来源和回滚旧楼层所需的历史数据。 */
export declare function loadTemplateTimers(fs: WorkspaceFs, sessionId: string): Promise<WITimerState>;
/** 普通计时更新与分支复制只改变计时字段；未迁移会话保留原路径，不创建空模板文件。 */
export declare function saveTemplateTimers(fs: WorkspaceFs, sessionId: string, timers: WITimerState): Promise<void>;
/** 分支草稿把边界定时器复制到子会话旧路径；不改祖先模板镜像，跨分支 WAL 才能逐层撤销。 */
export declare function copyTemplateTimers(fs: WorkspaceFs, fromSessionId: string, toSessionId: string): Promise<void>;
