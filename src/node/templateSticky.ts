/** 沙箱 sticky 生命周期：全量恢复注册表与过期墓碑，不把重建当重新注册，也不序列化闭包源码。 */
export const TEMPLATE_STICKY=String.raw`
let stickyRevision=0;
let stickyCallbackSerial=0;
const stickyCallbacks=new Map();
const stickyCallbackIds=new WeakMap();
const stickyTombstones={prompts:new Map(),basic:new Set(),generate:new Set(),message:new Set()};
function stickyCount(value,label='sticky') {
  if(!Number.isSafeInteger(value)||value<0) throw Error(label+' 必须是非负安全整数');
  return value;
}
function stickyFinite(value,label='sticky') {if(typeof value!=='number'||!Number.isFinite(value))throw Error(label+' 必须是有限数值');return value;}
function stickyIdentity(text) {
  // 仅对文本做稳定身份摘要；函数文本只用于上游式默认去重，绝不存入快照或用作可执行源码。
  let first=2166136261,second=0x9e3779b9;
  for(let i=0;i<text.length;i++) {const code=text.charCodeAt(i);first=Math.imul(first^code,16777619);second=Math.imul(second^code,2246822519);}
  return 'auto-'+(first>>>0).toString(16)+'-'+(second>>>0).toString(16)+'-'+text.length;
}
function stickyCallbackId(callback) {
  const known=stickyCallbackIds.get(callback);
  if(known && stickyCallbacks.get(known)===callback) return known;
  if(stickyCallbacks.size>=4096 || stickyCallbackSerial>=Number.MAX_SAFE_INTEGER) throw Error('sticky 回调超过上限');
  const id=++stickyCallbackSerial;stickyCallbacks.set(id,callback);stickyCallbackIds.set(callback,id);return id;
}
function stickyRegexCallbackIdentity(uuid,expression,options,callback) {
  return stickyIdentity(JSON.stringify([uuid,expression.source,expression.flags,options,String(callback)]));
}
function stickyNextRevision() {if(stickyRevision>=Number.MAX_SAFE_INTEGER) throw Error('sticky 注册修订超过上限');return ++stickyRevision;}
function rememberStickyRemoval(channel,id,value=id) {
  const removed=stickyTombstones[channel];
  if(!removed.has(id)&&removed.size>=4096) throw Error('sticky 过期记录超过上限');
  if(channel==='prompts') removed.set(id,value);else removed.add(id);
}
function deactivatePromptInjection(count=1) {
  stickyFinite(count,'清理次数');
  const changes=[];let removedCount=stickyTombstones.prompts.size;
  for(const [key,group] of injections) for(const [uid,item] of group) {
    const next=stickyFinite(item.sticky-count);
    if(next<0&&!stickyTombstones.prompts.has(JSON.stringify([key,uid])))removedCount++;
    changes.push({key,group,uid,item,next});
  }
  if(removedCount>4096)throw Error('sticky 过期记录超过上限');
  for(const {key,group,uid,item,next} of changes) {
    if(next>=0) item.sticky=next;
    else {rememberStickyRemoval('prompts',JSON.stringify([key,uid]),{key,uid});injectionSize-=item.prompt.length;injectionCount--;group.delete(uid);}
    if(!group.size) injections.delete(key);
  }
}
function exportTemplateStickyState() {
  const regex={basic:[],generate:[],message:[]};
  for(const channel of ['basic','generate','message']) for(const [uuid,rule] of temporaryRegex[channel]) {
    regex[channel].push({uuid,source:rule.expression.source,flags:rule.expression.flags,sticky:rule.sticky,revision:rule.revision,
      replacement:typeof rule.replacement==='function'?{kind:'callback',id:rule.callbackId,identity:rule.identity}:{kind:'text',value:rule.replacement},options:rule.options});
  }
  const state={version:1,revision:stickyRevision,callbackSerial:stickyCallbackSerial,
    prompts:[...injections].flatMap(([key,group])=>[...group].map(([uid,item])=>({key,uid,...item}))),regex,
    tombstones:{prompts:[...stickyTombstones.prompts.values()],basic:[...stickyTombstones.basic],generate:[...stickyTombstones.generate],message:[...stickyTombstones.message]}};
  const raw=JSON.stringify(state);if(raw.length>2*1024*1024) throw Error('sticky 状态超过 2 MiB 上限');return raw;
}
function restoreTemplateStickyState(state) {
  // 先构建和检查所有副本；缺失闭包或坏记录不能清掉当前注册表。
  const object=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('sticky 状态对象损坏');return value;};
  const text=(value,max=4096)=>{if(typeof value!=='string'||value.length>max)throw Error('sticky 状态文本无效');return value;};
  const list=value=>{if(!Array.isArray(value)||value.length>4096)throw Error('sticky 状态条目超过上限');return value;};
  object(state,['version','revision','callbackSerial','prompts','regex','tombstones']);
  if(state.version!==1||JSON.stringify(state).length>2*1024*1024)throw Error('sticky 状态版本无效或超限');
  stickyCount(state.revision);stickyCount(state.callbackSerial);
  object(state.regex,['basic','generate','message']);object(state.tombstones,['prompts','basic','generate','message']);
  const nextPrompts=new Map(),nextRegex={basic:new Map(),generate:new Map(),message:new Map()},nextRemoved={prompts:new Map(),basic:new Set(),generate:new Set(),message:new Set()};
  let nextSize=0;
  for(const raw of list(state.prompts)) {
    object(raw,['key','uid','prompt','order','sticky']);const key=text(raw.key),uid=text(raw.uid),prompt=text(raw.prompt,1024*1024);stickyFinite(raw.sticky);
    if(!Number.isFinite(raw.order))throw Error('sticky 顺序无效');
    const group=nextPrompts.get(key)||new Map();if(group.has(uid))throw Error('sticky 注入身份重复');
    group.set(uid,{prompt,order:raw.order,sticky:raw.sticky});nextPrompts.set(key,group);nextSize+=prompt.length;
  }
  if(nextSize>1024*1024||nextPrompts.size>1024)throw Error('sticky 注入总量超过上限');
  for(const raw of list(state.tombstones.prompts)) {
    object(raw,['key','uid']);const value={key:text(raw.key),uid:text(raw.uid)},id=JSON.stringify([value.key,value.uid]);
    if(nextRemoved.prompts.has(id)||nextPrompts.get(value.key)?.has(value.uid))throw Error('sticky 注入墓碑冲突');nextRemoved.prompts.set(id,value);
  }
  for(const channel of ['basic','generate','message']) {
    for(const raw of list(state.regex[channel])) {
      object(raw,['uuid','source','flags','sticky','revision','replacement','options']);const uuid=text(raw.uuid);
      text(raw.source,1024*1024);text(raw.flags,16);stickyFinite(raw.sticky);stickyCount(raw.revision);
      if(raw.revision>state.revision||nextRegex[channel].has(uuid))throw Error('sticky 正则身份或修订无效');
      object(raw.replacement,['kind','value','id','identity']);let replacement,callbackId,identity;
      if(raw.replacement.kind==='text') {replacement=text(raw.replacement.value,1024*1024);if('id' in raw.replacement||'identity' in raw.replacement)throw Error('sticky 替换描述无效');}
      else if(raw.replacement.kind==='callback') {
        callbackId=stickyCount(raw.replacement.id);if(callbackId<1||callbackId>state.callbackSerial||channel==='basic'||'value' in raw.replacement)throw Error('sticky 回调引用无效');
        identity=text(raw.replacement.identity);replacement=stickyCallbacks.get(callbackId);if(!replacement)throw Error('sticky 回调尚未由执行日志重建');
      } else throw Error('sticky 替换类型无效');
      object(raw.options,['user','assistant','system','worldinfo','message','generate','basic','order','before','after','minDepth','maxDepth']);
      for(const key of ['user','assistant','system','worldinfo','message','generate','basic','before','after'])if(typeof raw.options[key]!=='boolean')throw Error('sticky 正则选项无效');
      stickyFinite(raw.options.order);for(const key of ['minDepth','maxDepth'])if(raw.options[key]!==null)stickyFinite(raw.options[key]);
      if(raw.options.basic!==(channel==='basic')||raw.options.generate!==(channel==='generate')||raw.options.message!==(channel==='message'))throw Error('sticky 正则阶段无效');
      const options=normalizeTemporaryRegexOptions({...raw.options,basic:channel==='basic',generate:channel==='generate',message:channel==='message'});
      const expression=new RegExp(raw.source,raw.flags);
      if(identity!==undefined&&stickyRegexCallbackIdentity(uuid,expression,options,replacement)!==identity)throw Error('sticky 回调身份与重放注册不一致');
      nextRegex[channel].set(uuid,{expression,replacement,callbackId,identity,options,sticky:raw.sticky,revision:raw.revision});
    }
    for(const raw of list(state.tombstones[channel])) {const uuid=text(raw);if(nextRemoved[channel].has(uuid)||nextRegex[channel].has(uuid))throw Error('sticky 正则墓碑冲突');nextRemoved[channel].add(uuid);}
  }
  injections.clear();for(const [key,group] of nextPrompts)injections.set(key,group);injectionSize=nextSize;injectionCount=state.prompts.length;
  for(const channel of ['basic','generate','message']) {temporaryRegex[channel]=nextRegex[channel];stickyTombstones[channel]=nextRemoved[channel];}
  stickyTombstones.prompts=nextRemoved.prompts;stickyRevision=state.revision;stickyCallbackSerial=state.callbackSerial;
  for(const id of stickyCallbacks.keys())if(id>stickyCallbackSerial)stickyCallbacks.delete(id);
}
globalThis.__exportTemplateStickyState=exportTemplateStickyState;
globalThis.__restoreTemplateStickyState=restoreTemplateStickyState;
globalThis.__beginTemplateGeneration=()=>{resetTemplateBasicRegex();resetTemplateRegexSources();deactivateRegex({message:true});};
globalThis.__clearTemplateBasicRegex=()=>{deactivateRegex({basic:true});basicRegexPhaseClosed=true;};
globalThis.__finishTemplateGeneration=()=>{deactivateRegex({generate:true,basic:true});deactivatePromptInjection();};
globalThis.__deactivateTemplateRegex=deactivateRegex;
globalThis.__deactivateTemplatePromptInjection=deactivatePromptInjection;
globalThis.__hasLiveTemplateClosures=()=>['generate','message'].some(channel=>[...temporaryRegex[channel].values()].some(rule=>typeof rule.replacement==='function'));
`;
