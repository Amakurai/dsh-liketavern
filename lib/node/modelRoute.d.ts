/**
 * 会话此刻实际使用的模型路由，供上下文窗口、模板 model 变量与 idle 记忆压缩等辅助用途。
 * agent.options 只是会话创建/恢复时的全局默认模型：会话内换模由宿主 model-selection 在
 * agent/request 覆盖，从不回写 options。因此优先最近一次请求头，缺失时才回退 options。
 * 请求头可能记录本插件的 DeepSeek 布局通道；辅助调用没有提示词布局，映射回同凭证的官方 provider。
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
export interface SessionModelRoute {
    provider?: string;
    model?: string;
}
export declare function sessionModelRoute(agent: Pick<Agent, 'options' | 'session'>): SessionModelRoute;
