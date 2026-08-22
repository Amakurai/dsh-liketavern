/**
 * dsh-tavern agent 面插件（由 agent 预设 tavern 挂载，运行于 agent 作用域）。
 * 职责：
 * 1. 注册稳定 system 段 `tavern:standing` 与本轮 runtime context `tavern:turn`。
 *    已绑定：standing = 角色定义 + 预设骨架（冻结时钟，按会话钉死字节）；
 *    turn = 固定 playbook（不随 step 变，宿主按字节去重不重复追加）+ 世界书/记忆/变化层。
 *    未绑定：standing 固定短文案（不删段，避免段布局抖动打穿 KV），turn 为空。
 *    standing 段 order=210，排在工具说明（100–199）之后：即使骨架仍有残余抖动，
 *    稳定的工具说明仍能命中 DeepSeek 前缀缓存。绝不把整包 ST 预设改成 complete 段。
 * 2. 在 agent/request waterfall 中合入采样参数（temperature/maxTokens/stop）
 *    与 thinking→reasoningEffort（只写模型公布的档位；模型元数据经
 *    state.resolveModelInfoCached 进程内缓存，每步调用不重复解析）。
 * 3. 注册七个 Tavern 模型工具；agent/status 转入 idle 时 runMaintenance
 *    执行记忆超容量压缩（memoryMaintenance.ts，不记 WAL）。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-tavern-agent";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
