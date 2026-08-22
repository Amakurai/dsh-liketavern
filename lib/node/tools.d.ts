/**
 * Tavern 模型工具：记忆检索/写入/更新、世界书按条阅读、世界状态更新、资产清单/阅读。
 * 全部经 exec.agent 定位会话绑定与角色工作区；写操作经 WorkspaceFs（落入楼层 WAL）。
 *
 * WI/记忆检索按 turn 缓存（pipeline.ts），工具写入不重评世界书定时器——这是有意的。
 * 写入成功后经 agent.inject 发一条同轮确认（不当作用户台词、不扫世界书），
 * 下一步看得到，检索层仍从下一 turn 起生效。
 * 工具执行（含读工具）还会按 turn:nextStep 去重注入【Tavern 步骤】收口通知：
 * turn playbook 是固定文本（吃宿主快照去重），多步压力改由这条 inject 承载。
 * 记忆超容量压缩不在工具内同步执行：只标记 state.pendingMemoryCompress，
 * turn 结束后由 memoryMaintenance.ts 的 runMaintenance 合并（不记 WAL，不回滚）。
 * 所有读工具的结果都有条数与 token 预算上限（检索/目录一律截断并报告 omitted/truncated），
 * 不把整库正文或整棵工作区目录灌进上下文。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TavernState } from './state.js';
export declare function registerTavernTools(ctx: Context, state: TavernState): void;
