/** 模板运行的可序列化重放契约：记录真实操作和结果指纹，重建词法闭包而不序列化函数源码。 */
import type { TemplateContext,TemplateScopes,TemplateMessageMetadata } from './template.js'
import type { TemplateReplayBootstrap } from './templateContinuation.js'
import type { TemplateStickyState } from './templateSticky.js'

export type TemplateReplayInstruction =
  | {kind:'render';text:string;data:Record<string,unknown>;source?:string}
  | {kind:'regex';text:string;stage:'generate'|'message'|'after';meta:{role:string;worldinfo:boolean;depth:number}}
  | {kind:'variables'}
  | {kind:'outlets';text:string}
  | {kind:'deferOutlets';value:boolean}
  | {kind:'phase';context:TemplateContext;refreshPreload:boolean}
  | {kind:'message';metadata:TemplateMessageMetadata|null}
  | {kind:'format';text:string}
  | {kind:'messageVariables'}
  | {kind:'sticky';action:'begin'|'finish'|'restore';state?:TemplateStickyState}

export type TemplateReplayOperation = TemplateReplayInstruction & {hash:string}

export interface TemplateReplay {
  version:2
  /** 缺省表示旧 Showdown；可读取备份，但活动日志必须在旧版本完成或回滚，禁止静默迁移闭包。 */
  formatterVersion?:2
  context:TemplateContext
  operations:TemplateReplayOperation[]
  variables:TemplateScopes
  messageVariablesHash:string
  bootstrap?:TemplateReplayBootstrap
}

export const TEMPLATE_REPLAY_LIMIT = 4 * 1024 * 1024

/** 外显哈希不覆盖闭包中的隐式格式化捕获，旧引擎的活动日志必须先在旧版本完成或回滚。 */
export function assertTemplateReplayFormatter(replay:Pick<TemplateReplay,'formatterVersion'>):void {
  if(replay.formatterVersion===undefined) throw new Error('消息格式化器已更新，旧模板包含未完成重放或跨轮闭包，已拒绝执行和提交；请备份后使用旧版本完成或回滚相关楼层')
  if(replay.formatterVersion!==2) throw new Error('模板消息格式化器版本不兼容，需要完成或回滚旧版本楼层')
}

export function templateReplayGenerationContext(replay:TemplateReplay):TemplateContext {
  for(const operation of [...replay.operations].reverse()) if(operation.kind==='phase' && operation.context.phase==='generate') return operation.context
  return replay.context
}
