import { type TemplateScopes } from '../core/template.js';
import { type WITimerState } from '../core/types.js';
import type { WorkspaceFs } from './workspaceFs.js';
import { type TemplateGeneration } from './templateGeneration.js';
import { TEMPLATE_DISPLAY_PARTS_VERSION, type TemplateDisplayPart } from '../core/templateDisplay.js';
import { type TemplateMessageVariables } from '../core/templateMessageVariables.js';
import type { TemplateContinuation } from '../core/templateContinuation.js';
export declare const TEMPLATE_STATE_PATH = "state/template.json";
/**
 * 未结束轮次的冻结计划与闭包重放正文。它每轮整体替换、收口即作废，体积又随可见历史增长：
 * 留在分块历史里，每轮都会产生几十个只用一次的数据块并把同样的字节再写进楼层日志。
 * 大型状态把正文按内容摘要单独存放，根里只留归属与摘要；回滚只恢复根，仍可恢复的根引用正文必须保留。
 */
export declare const TEMPLATE_GENERATION_PATH = "state/template-generation";
export interface TemplateState {
    version: 1;
    variables: TemplateScopes;
    messageVariables?: TemplateMessageVariables;
    continuation?: TemplateContinuation;
    outputs: Record<string, {
        hash: string;
        text: string;
        parts?: TemplateDisplayPart[];
        partsVersion?: typeof TEMPLATE_DISPLAY_PARTS_VERSION;
    }>;
    /** 与生成变量在同一次原子替换中提交；缺字段的旧状态继续读取独立定时文件。 */
    wiTimers?: Record<string, WITimerState>;
    /** 未完成轮的闭包重放与冻结计划；完成后缩成归属回执，防止重启重复执行。 */
    generation?: TemplateGeneration;
}
export declare const templateTextHash: (text: string) => string;
export declare function loadTemplateState(fs: WorkspaceFs): Promise<TemplateState>;
/** 生成归属用于生命周期判断，不必为查一个楼层复制整份冻结计划和历史回复。 */
export type TemplateGenerationIdentity = Pick<TemplateGeneration, 'version' | 'status' | 'sessionId' | 'cardId' | 'storyId' | 'turn' | 'floor'>;
export declare function loadTemplateGenerationIdentity(fs: WorkspaceFs): Promise<TemplateGenerationIdentity | undefined>;
/** 只读取生成记录；正文按需恢复，历史 outputs 与消息变量不参与本次复制。 */
export declare function loadTemplateGeneration(fs: WorkspaceFs): Promise<TemplateGeneration | undefined>;
/** 组装、恢复校验使用变量与生成数据；无需回复快照的调用不复制随楼层增长的 outputs。 */
export type TemplateMetadata = Omit<TemplateState, 'outputs'>;
export declare function loadTemplateMetadata(fs: WorkspaceFs): Promise<TemplateMetadata>;
/** 展示按真实消息身份读取快照；冷启动也不展开其它回复的正文和卡面片段。 */
export declare function loadTemplateOutputs(fs: WorkspaceFs, messageIds: readonly number[]): Promise<TemplateState['outputs']>;
/** 渲染单条消息或续写片段只提取需要的回复；project 的输入递归冻结，返回值单独复制。 */
export declare function selectTemplateOutputs<R>(fs: WorkspaceFs, project: (outputs: Readonly<TemplateState['outputs']>) => R): Promise<R>;
export declare function saveTemplateState(fs: WorkspaceFs, state: TemplateState): Promise<void>;
/**
 * 冻结计划等元数据写入保留提交时最新的回复快照，不用把完整 outputs 交给组装管线往返复制。
 * 只在同一工作区锁内借用缓存的递归冻结视图；写入器只读 outputs，这份引用不会暴露给调用方。
 */
export declare function saveTemplateMetadata(fs: WorkspaceFs, metadata: TemplateMetadata): Promise<void>;
/** 新状态优先；旧文件保留为迁移来源和回滚旧楼层所需的历史数据。 */
export declare function loadTemplateTimers(fs: WorkspaceFs, sessionId: string): Promise<WITimerState>;
/**
 * 普通计时更新与分支复制只改变计时字段；未迁移会话保留原路径，不创建空模板文件。
 * 内容未变时不重写：每轮都落一条同值 WAL 记录既无意义，也会给后续楼层回滚制造假依赖。
 */
export declare function saveTemplateTimers(fs: WorkspaceFs, sessionId: string, timers: WITimerState): Promise<void>;
/** 分支草稿把边界定时器复制到子会话旧路径；不改祖先模板镜像，跨分支 WAL 才能逐层撤销。 */
export declare function copyTemplateTimers(fs: WorkspaceFs, fromSessionId: string, toSessionId: string): Promise<void>;
