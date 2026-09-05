/** 临时正则在 QuickJS 内按 basic/generate/message 独立注册；sticky 生命周期不丢弃词法闭包。 */
import { TEMPLATE_STICKY } from './templateSticky.js';
import { TEMPLATE_REGEX_SOURCES } from './templateRegexSources.js';
export const TEMPLATE_REGEX = String.raw `
${TEMPLATE_STICKY}
const temporaryRegex = {basic:new Map(),generate:new Map(),message:new Map()};
let frozenBasicRegex=null;
let basicRegexPhaseClosed=false;
function resetTemplateBasicRegex() {frozenBasicRegex=null;basicRegexPhaseClosed=false;}
globalThis.__prepareTemplateBasicRegex=()=>{
  if(frozenBasicRegex===null)frozenBasicRegex=new Map([...temporaryRegex.basic].map(([uuid,rule])=>[uuid,{...rule,options:{...rule.options},expression:new RegExp(rule.expression.source,rule.expression.flags)}]));
};
function normalizeTemporaryRegexOptions(opts) {
  const options={user:true,assistant:true,system:true,worldinfo:false,message:false,generate:false,order:100,
    basic:opts.basic ?? (opts.message==null && opts.generate==null),before:opts.before ?? (opts.after==null && opts.html==null),after:false};
  for(const key of Object.keys(options)) if(opts[key]!=null) options[key]=opts[key];
  for(const key of ['user','assistant','system','worldinfo','message','generate','basic','before','after']) if(typeof options[key]!=='boolean') throw Error('正则开关必须是布尔值');
  if(!Number.isFinite(options.order)) throw Error('正则顺序必须是有限数值');
  for(const key of ['minDepth','maxDepth']) {
    if(opts[key]!=null && !Number.isFinite(opts[key]) && !Number.isNaN(opts[key])) throw Error('正则深度必须是有限数值或 NaN');
    options[key]=opts[key]==null || Number.isNaN(opts[key]) ? null : opts[key];
  }
  return options;
}
function activateRegex(pattern,replacement,opts={}) {
  if(!opts || typeof opts!=='object' || Array.isArray(opts)) throw Error('临时正则选项必须是对象');
  const allowed=['uuid','minDepth','maxDepth','user','assistant','system','worldinfo','reasoning','message','generate','basic','order','before','after','html','sticky'];
  for(const key of Object.keys(opts)) if(!allowed.includes(key)) throw Error('未知临时正则选项：'+key);
  if(opts.reasoning) throw Error('activateRegex 不读取宿主隐藏推理');
  if(opts.html) throw Error('activateRegex 暂不支持最终 DOM HTML 替换');
  if(typeof replacement!=='string' && typeof replacement!=='function') throw Error('正则替换必须是字符串或函数');
  let expression;
  if(pattern instanceof RegExp) expression=new RegExp(pattern.source,pattern.flags);
  else if(typeof pattern==='string') {
    const literal=/^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(pattern);
    expression=literal ? new RegExp(literal[1],literal[2]) : new RegExp(pattern,'g');
  } else throw Error('正则模式必须是字符串或 RegExp');
  const options=normalizeTemporaryRegexOptions(opts);
  if(options.basic && typeof replacement!=='string') throw Error('basic 正则替换必须是字符串');
  if(opts.uuid!=null && typeof opts.uuid!=='string') throw Error('正则 uuid 必须是字符串');
  const uuid=opts.uuid || stickyIdentity(String(pattern)+'@'+String(replacement));
  const sticky=stickyFinite(opts.sticky ?? 0);
  if(uuid.length>4096 || expression.source.length>1024*1024 || typeof replacement==='string'&&replacement.length>1024*1024) throw Error('临时正则文本超过上限');
  const channels=['basic','generate','message'].filter(channel=>options[channel]);
  for(const channel of channels) if(!temporaryRegex[channel].has(uuid)&&temporaryRegex[channel].size>=4096) throw Error('临时正则条目超过上限');
  if(!channels.length)return;
  const callbackId=typeof replacement==='function'?stickyCallbackId(replacement):undefined;
  const revision=stickyNextRevision();
  for(const channel of channels) {
    const selected={...options,basic:channel==='basic',generate:channel==='generate',message:channel==='message'};
    const identity=callbackId===undefined?undefined:stickyRegexCallbackIdentity(uuid,expression,selected,replacement);
    temporaryRegex[channel].set(uuid,{expression:new RegExp(expression.source,expression.flags),replacement,options:selected,sticky,revision,callbackId,identity});
    stickyTombstones[channel].delete(uuid);
  }
}
function deactivateRegex(selector={},count=1) {
  if(!selector||typeof selector!=='object'||Array.isArray(selector)||Object.keys(selector).some(key=>!['uuid','basic','generate','message'].includes(key))) throw Error('临时正则选择器无效');
  if(selector.uuid!=null&&typeof selector.uuid!=='string')throw Error('临时正则 uuid 必须是字符串');
  for(const channel of ['basic','generate','message'])if(selector[channel]!=null&&typeof selector[channel]!=='boolean')throw Error('临时正则选择开关必须是布尔值');
  stickyFinite(count,'清理次数');
  const changes=[];
  for(const channel of ['basic','generate','message']) {
    if(!selector.uuid&&!selector[channel])continue;
    let removedCount=stickyTombstones[channel].size;
    for(const [uuid,rule] of temporaryRegex[channel]) {
      if(selector.uuid&&selector.uuid!==uuid)continue;
      const next=stickyFinite(rule.sticky-count);
      if((channel==='basic'||next<=0)&&!stickyTombstones[channel].has(uuid))removedCount++;
      changes.push({channel,uuid,rule,next});
    }
    if(removedCount>4096)throw Error('sticky 过期记录超过上限');
  }
  for(const {channel,uuid,rule,next} of changes) {
      if(channel==='basic'||next<=0) {rememberStickyRemoval(channel,uuid);temporaryRegex[channel].delete(uuid);}
      else rule.sticky=next;
  }
}
function templateRegexRulesForStage(stage,meta) {
  if(!['basic','generate','message','after'].includes(stage))throw Error('未知临时正则阶段');
  const channels=stage==='generate'?(basicRegexPhaseClosed?['generate']:['basic','generate']):stage==='basic'?['basic']:['message'];
  return channels.flatMap(channel=>[...(stage==='basic'&&frozenBasicRegex!==null?frozenBasicRegex:temporaryRegex[channel])].sort((a,b)=>a[1].options.order-b[1].options.order).flatMap(([uuid,rule])=>{
    const o=rule.options;
    if(channel==='message'&&!(stage==='after'?o.after:o.before))return [];
    if(meta.worldinfo?!o.worldinfo:meta.role==='user'?!o.user:meta.role==='assistant'?!o.assistant:meta.role==='system'?!o.system||channel==='basic':true)return [];
    if(o.minDepth!=null&&o.minDepth>=0&&meta.depth<o.minDepth||o.maxDepth!=null&&o.maxDepth>=0&&meta.depth>o.maxDepth)return [];
    return [{...rule,id:channel+':'+uuid+':'+rule.revision}];
  }));
}
function applyTemporaryRegex(text,stage,meta) {
  for(const rule of templateRegexRulesForStage(stage,meta)) {
    rule.expression.lastIndex=0;
    const replacement=typeof rule.replacement==='function'
      ? (...args)=> {const value=rule.replacement.apply(api,args);if(value&&typeof value.then==='function')throw Error('正则替换回调必须同步返回');return String(value);}
      : rule.replacement;
    text=text.replace(rule.expression,replacement);
    if(text.length>1024*1024)throw Error('临时正则输出超过 1 MiB 上限');
  }
  return text;
}
api.activateRegex=activateRegex;
for(const rule of input.regexRules || []) activateRegex(new RegExp(rule.source,rule.flags),rule.replacement,rule.options);
globalThis.__applyTemporaryRegex=applyTemporaryRegex;
globalThis.__hasMessageRegex=()=>temporaryRegex.message.size>0;
globalThis.__regexDescriptors=()=>JSON.stringify([...temporaryRegex.message].filter(([,rule])=>typeof rule.replacement==='string')
  .map(([uuid,rule])=>({source:rule.expression.source,flags:rule.expression.flags,replacement:rule.replacement,options:{...rule.options,uuid,sticky:rule.sticky}})));
${TEMPLATE_REGEX_SOURCES}
`;
