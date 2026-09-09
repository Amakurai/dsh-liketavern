/** MVU 模板当前基准：按后台继承顺序读取本剧情原始聊天的最近有效变量，模型摘要不删除已保存状态。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { type HelperScopes } from '../core/helperRuntime.js';
import type { TemplateVariables } from '../core/template.js';
export declare function currentHelperMvuTemplateData(events: readonly SessionEvent[], scopes: HelperScopes): TemplateVariables | undefined;
