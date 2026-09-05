/** 同一个 QuickJS 环境跨轮推进，旧闭包仍共享词法变量；当前资产、历史、时钟与变量每轮重新冻结。 */
import type { TemplateSandbox } from './templateSandbox.js'
import type { TemplateContext } from '../core/template.js'
import type { TemplateContinuation } from '../core/templateContinuation.js'
import { hasTemplateStickyClosures } from '../core/templateSticky.js'
import { parseTemplateContinuation,templatePreloadRevision } from '../state/templateContinuation.js'

export async function prepareContinuedTemplate(Sandbox:typeof TemplateSandbox,context:TemplateContext,value?:TemplateContinuation):Promise<TemplateSandbox> {
  const carry=value && parseTemplateContinuation(value)
  const refresh=!carry || carry.preloadRevision!==templatePreloadRevision(context)
  if(carry?.replay) {
    let sandbox=await Sandbox.rebuild(carry.replay)
    let disposed=false
    try {
      if(JSON.stringify(sandbox.stickyState())!==JSON.stringify(carry.state)) throw new Error('sticky 注册表与闭包重放不一致')
      sandbox.resume(context,refresh)
      const remaining=sandbox.sticky('begin')
      if(!hasTemplateStickyClosures(remaining)) {
        sandbox.dispose()
        disposed=true
        sandbox=await Sandbox.create(context,true,{state:remaining,preload:'preserve'})
        disposed=false
      }
      return sandbox
    } catch(error) {if(!disposed) sandbox.dispose();throw error}
  }
  if(carry && hasTemplateStickyClosures(carry.state)) throw new Error('跨轮 sticky 回调缺少执行日志')
  const sandbox=await Sandbox.create(context,true,carry ? {state:carry.state,preload:refresh?'refresh':'preserve'} : undefined)
  try {sandbox.sticky('begin');return sandbox} catch(error) {sandbox.dispose();throw error}
}

export function exportTemplateContinuation(sandbox:TemplateSandbox,context:TemplateContext,includeReplay=false):TemplateContinuation {
  const state=sandbox.stickyState()
  return {version:1,preloadRevision:templatePreloadRevision(context),state,
    ...(includeReplay && hasTemplateStickyClosures(state) ? {replay:sandbox.replay()} : {})}
}

export const TEMPLATE_CONTINUATION=String.raw`
globalThis.__continueTemplateGeneration=context=> {
  if(!equal(scopes,context.variables)) throw Error('模板跨轮变量与已提交状态不一致');
  syncCurrentMessageVariables();
  const visible=new Set(context.historyIdentities?.map(item=>item.messageId) || context.history.map((_,index)=>'preview:'+index));
  for(const [id,frame] of Object.entries(messageSnapshots.snapshots)) {
    const current=context.messageVariables?.snapshots[id];
    if(visible.has(id) && (!current || !equal(frame,current))) throw Error('模板跨轮历史变量与已提交状态不一致');
  }
  for(const key of Object.keys(input)) delete input[key];
  Object.assign(input,clone(context));
  for(const key of Object.keys(initial)) delete initial[key];
  for(const entry of input.entries.filter(e=>e.enabled && /^\[InitialVariables\]/i.test(e.comment))) merge(initial,JSON.parse(entry.content));
  Object.assign(scopes,clone(context.variables));
  messageSnapshots=clone(context.messageVariables || {version:1,snapshots:{}});
  messageIdentities=context.historyIdentities || context.history.map((_,index)=>({messageId:'preview:'+index,swipeId:0}));
  currentMessageIndex=-1;preparingMessageSnapshots=null;
  variables=merge(merge(merge(clone(initial),scopes.global),scopes.local),scopes.message);
  api.variables=variables;api.initialVariables=initial;
  initializeTemplateMessageVariables();
  seed=input.seed>>>0;
  preparing=false;api.runType='generate';templateOutletsDeferred=false;
  activations.clear();
  templateRegexMatchCache.clear();templateRegexCacheChars=0;
  api.charLoreBook=input.entries.find(e=>e.source==='character')?.sourceRef;
  api.userLoreBook=input.entries.find(e=>e.source==='persona')?.sourceRef;
  api.chatLoreBook=input.entries.find(e=>e.source==='chat')?.sourceRef;
  __resetTemplateFaker();
  __refreshTemplateContext();
  rememberSchemaState();
};
`;
