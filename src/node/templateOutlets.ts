/** 延迟命名注入：QuickJS 内收集后展开，worker 最后统一处理提示词通道并重新核对体积。 */
import type { AssembledPrompt } from '../core/assemble.js'
import { estimateTokens } from '../core/tokenize.js'

const OUTLET_PREFIX = '{{outletPromptsInjected:'
/** 仅识别固定文本前缀；宿主不得执行用户正则或注入正文。 */
export function containsTemplateOutlet(text: string): boolean { return text.includes(OUTLET_PREFIX) }

/** 置于 TEMPLATE_HELPERS 后；只在同一 QuickJS 上下文读取命名列表，不再次执行 EJS 或后处理回调。 */
export const TEMPLATE_OUTLETS = String.raw`
let templateOutletsDeferred = false;
globalThis.__setTemplateOutletsDeferred = value => {
  if (typeof value!=='boolean') throw Error('模板出口延迟标记必须是布尔值');
  templateOutletsDeferred=value;
};
globalThis.__resolveTemplateOutlets = text => {
  if (typeof text!=='string') throw Error('模板出口正文必须是字符串');
  const prefix='{{outletPromptsInjected:', memo=new Map(), active=new Set();
  let substitutions=0, workChars=0;
  const expand=(source,depth)=> {
    if (!source.includes(prefix)) return source;
    if (depth>32) throw Error('注入出口嵌套超过 32 层上限');
    workChars+=source.length;
    if (workChars>4*1024*1024) throw Error('注入出口展开工作量超过 4 MiB 上限');
    const parts=[]; let offset=0, chars=0;
    const append=part=> {
      chars+=part.length;
      if (chars>1024*1024) throw Error('注入出口展开结果超过 1 MiB 上限');
      parts.push(part);
    };
    while (true) {
      const start=source.indexOf(prefix,offset);
      if (start<0) { append(source.slice(offset)); break; }
      append(source.slice(offset,start));
      const end=source.indexOf('}}',start+prefix.length);
      if (end<0) throw Error('注入出口缺少结束标记');
      const key=source.slice(start+prefix.length,end);
      if (!key || key.length>4096 || /[\r\n]/.test(key)) throw Error('注入出口名称无效或超过 4096 字符');
      if (++substitutions>4096) throw Error('注入出口替换次数超过 4096 次上限');
      if (!memo.has(key)) {
        if (active.has(key)) throw Error('注入出口存在循环引用：'+key);
        active.add(key);
        try { memo.set(key,expand(getPromptsInjected(key,[],false),depth+1)); }
        finally { active.delete(key); }
      }
      append(memo.get(key));
      offset=end+2;
    }
    return parts.join('');
  };
  return expand(text,0);
};
`;

/** 调用者必须在所有来源和定位注入已收敛后调用；预算检查通过前不得导出或提交模板变量。 */
export function finalizeTemplateOutlets<T extends AssembledPrompt>(
  assembled:T, sandbox:{resolveOutlets(text:string):string}, budget:number,
):T {
  const texts = [assembled.standing,assembled.turnContext,...assembled.messages.map(m=>m.content),...assembled.history.map(m=>m.content)]
  if (!texts.some(containsTemplateOutlet)) return assembled
  const resolved = new Map<string,string>()
  const expand = (text:string):string => {
    if (!containsTemplateOutlet(text)) return text
    if (!resolved.has(text)) resolved.set(text,sandbox.resolveOutlets(text))
    return resolved.get(text)!
  }
  const messages = assembled.messages.map(message=>({...message,content:expand(message.content)}))
  const history = assembled.history.map(message=>({...message,content:expand(message.content)}))
  let standing = expand(assembled.standing), turnContext = expand(assembled.turnContext)
  const movedStanding = containsTemplateOutlet(assembled.standing)
  // core 应提前将含出口的来源标为动态；若正则等后处理新造出口，保守迁移整段以免钉死动态内容。
  if (movedStanding) {
    turnContext = [standing,turnContext].filter(Boolean).join('\n\n')
    standing = ''
  }
  const tokensAfter = messages.reduce((total,message)=>total+estimateTokens(message.content),0)
  const system = [standing,turnContext].filter(Boolean).join('\n\n')
  if (tokensAfter>budget || estimateTokens(system)>budget) throw new Error('延迟注入展开后的提示词超过可用窗口，请缩减注入或提高上下文容量')
  return {...assembled,messages,history,standing,turnContext,system,
    log:[...assembled.log,{kind:'template-placement',detail:`延迟命名注入已在完整组装后展开${movedStanding?'；动态 standing 已迁入 tavern:turn':''}`}],
    stats:{...assembled.stats,tokensAfter}}
}
