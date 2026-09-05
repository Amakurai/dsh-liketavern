/** 跨轮模板续存只包含当前剧情的注册表和必要闭包日志；资产修订使用内容指纹，不受轮次或变量影响。 */
import type { TemplateContext } from './template.js';
import type { TemplateReplay } from './templateReplay.js';
import type { TemplateStickyState } from './templateSticky.js';
export interface TemplateContinuation {
    version: 1;
    preloadRevision: string;
    state: TemplateStickyState;
    /** prepared 阶段复用 generation.replay，收口后仅存仍有活跃回调的执行日志。 */
    replay?: TemplateReplay;
}
/** 首次重建的预加载与既有注册表的相对次序必须随日志保存，否则下一次重放会重置过期计数。 */
export interface TemplateReplayBootstrap {
    state: TemplateStickyState;
    preload: 'preserve' | 'refresh';
}
export declare function templatePreloadAssets(context: TemplateContext): unknown;
