/** QuickJS 内的历史消息变量：按可见稳定身份选择、一次继承和导出；从不访问宿主或其他剧情。 */
export const TEMPLATE_MESSAGE_VARIABLES=String.raw`
let messageSnapshots=clone(input.messageVariables || {version:1,snapshots:{}});
let messageIdentities=input.historyIdentities || input.history.map((_,index)=>({messageId:'preview:'+index,swipeId:0}));
let currentMessageIndex=-1;
let preparingMessageSnapshots=null;
let messageSchemaBaseline=new Map();
function validateMessageFilter(filter) {
  if (!filter || typeof filter!=='object' || Array.isArray(filter)
    || Object.keys(filter).some(key=>!['id','role','swipe_id'].includes(key))
    || filter.id!==undefined && !Number.isSafeInteger(filter.id)
    || filter.swipe_id!==undefined && !Number.isSafeInteger(filter.swipe_id)
    || filter.role!==undefined && !['system','user','assistant','any'].includes(filter.role)) throw Error('withMsg 消息筛选无效');
  return filter;
}
function snapshotAt(index) { return messageSnapshots.snapshots[messageIdentities[index]?.messageId]; }
function findMessageVariables(key,end=input.history.length) {
  if (!Number.isSafeInteger(end)) throw Error('findVariables 消息边界必须是整数');
  const limit=end<0 ? Math.max(0,input.history.length+end) : Math.min(end,input.history.length);
  for(let index=limit-1;index>=0;index--) {
    const frame=snapshotAt(index);
    if(frame && (key==null || get(frame.values,key,null)!=null)) return frame.values;
  }
  return initial;
}
function inheritMessageVariables(index,baseline) {
  const id=messageIdentities[index]?.messageId;
  if(!id) throw Error('消息变量缺少稳定身份');
  let frame=messageSnapshots.snapshots[id];
  if(!frame?.initialized) {
    const previous=baseline===undefined ? findMessageVariables(undefined,index) : baseline;
    frame={values:clone(Object.assign({},previous,frame?.values || {})),initialized:true};
    messageSnapshots.snapshots[id]=frame;
  }
  return frame.values;
}
function selectCurrentMessage(index) {
  if(!Number.isSafeInteger(index) || index<0 || index>=input.history.length) throw Error('消息变量当前索引无效');
  currentMessageIndex=index;
  scopes.message=inheritMessageVariables(index);
  variables=merge(merge(merge(clone(initial),scopes.global),scopes.local),scopes.message);
  api.variables=variables;
  rememberSchemaState();
}
function syncCurrentMessageVariables() {
  if(preparing || currentMessageIndex<0) return;
  const frame=snapshotAt(currentMessageIndex);
  if(frame) frame.values=scopes.message;
}
function initializeTemplateMessageVariables() {
  messageSchemaBaseline=new Map(Object.entries(messageSnapshots.snapshots).map(([id,frame])=>[id,JSON.stringify(frame.values)]));
  if(!input.history.length) return;
  const last=input.history.length-1;
  if(!input.messageVariables || !Object.keys(messageSnapshots.snapshots).length) {
    // 旧单树只锚到当前消息，不伪造每条旧消息的历史状态。
    inheritMessageVariables(last,Object.assign({},initial,scopes.message));
  } else {
    let anchor=last;
    while(anchor>=0 && !snapshotAt(anchor)) anchor--;
    for(let index=Math.max(anchor+1,0);index<=last;index++) inheritMessageVariables(index);
  }
  selectCurrentMessage(last);
}
function selectMessageVariables(filter,getter) {
  filter=validateMessageFilter(filter);
  let index=-1;
  if(filter.id!==undefined) index=filter.id<0 ? input.history.length+filter.id : filter.id;
  else if(filter.role!==undefined) {
    index=input.history.findLastIndex((message,index)=>(filter.role==='any'||message.role===filter.role)&&(!getter||snapshotAt(index)));
  } else {
    index=Number.isSafeInteger(api.message_id) ? api.message_id : input.history.length-1;
    if(getter) while(index>=0 && !snapshotAt(index)) index--;
  }
  if(index<0 || index>=input.history.length) return null;
  const swipe=filter.swipe_id ?? api.swipe_id ?? messageIdentities[index].swipeId;
  // 当前剧情只有一个可见版本；绝不从兄弟剧情拼接 swipe 数组。
  if(swipe!==0 && swipe!==-1) {
    if(getter) return null;
    throw Error('withMsg 指定的 swipe 不在当前剧情中');
  }
  return {index,frame:snapshotAt(index)};
}
function getHistoricalVariable(key,opts) {
  const selected=selectMessageVariables(opts.withMsg,true);
  let value=get(selected?.frame?.values,key,opts.defaults);
  if(opts.index!=null) value=get(value,opts.index,opts.defaults);
  return opts.clone ? clone(value) : value;
}
function writeHistoricalVariable(key,value,opts,remove=false) {
  const selected=selectMessageVariables(opts.withMsg,false);
  if(!selected) return undefined;
  const target=clone(selected.frame?.values || {}), old=clone(get(target,key));
  const exists=get(target,key)!==undefined;
  if((/^nx/.test(opts.flags||'')&&exists)||(/^xx/.test(opts.flags||'')&&!exists)) return undefined;
  if(opts.index!=null) {
    const indexed=clone(get(target,key,{}));
    if(remove) unsetHistorical(indexed,opts.index); else set(indexed,opts.index,value);
    value=indexed;remove=false;
  }
  if(opts.merge) value=merge(old && typeof old==='object' ? old : {},value);
  let next=target;
  if(key==null) {
    if(remove) next={};
    else {if(!value || typeof value!=='object'||Array.isArray(value)) throw Error('变量树必须是对象');next=clone(value);}
  } else if(remove) unsetHistorical(next,key); else set(next,key,value);
  validate(next);
  const combined=merge(merge(merge(clone(initial),scopes.global),scopes.local),next);
  copySchemaChanges(next,combined,checkVariableSchema(combined));
  const id=messageIdentities[selected.index].messageId;
  messageSnapshots.snapshots[id]={values:next,initialized:selected.frame?.initialized ?? false};
  if(selected.index===currentMessageIndex) {
    scopes.message=next;
    variables=merge(merge(merge(clone(initial),scopes.global),scopes.local),next);
    api.variables=variables;
  }
  rememberSchemaState();
  return opts.results==='old' ? old : opts.results==='fullcache' ? variables : get(next,key);
}
function unsetHistorical(object,key) {
  const parts=path(key),last=parts.pop();let parent=object;
  for(const part of parts) {parent=parent?.[part];if(!parent || typeof parent!=='object') return;}
  delete parent[last];
}
function exportTemplateMessageVariables() {
  syncCurrentMessageVariables();
  validate(messageSnapshots);
  if(Object.keys(messageSnapshots.snapshots).length>4096 || JSON.stringify(messageSnapshots).length>1048576) throw Error('消息变量快照超过上限');
  for(const [id,frame] of Object.entries(messageSnapshots.snapshots)) {
    if(variableSchema && messageSchemaBaseline.get(id)!==JSON.stringify(frame.values)) checkVariableSchema(merge(merge(merge(clone(initial),scopes.global),scopes.local),frame.values));
  }
  return JSON.stringify(messageSnapshots);
}
function prepareMessageVariables(value) {
  if(value) preparingMessageSnapshots=clone(messageSnapshots);
  else if(preparingMessageSnapshots) {
    messageSnapshots=preparingMessageSnapshots;preparingMessageSnapshots=null;
    if(currentMessageIndex>=0) scopes.message=snapshotAt(currentMessageIndex).values;
  }
}
globalThis.__exportMessageVariables=exportTemplateMessageVariables;
api.findVariables=findMessageVariables;
initializeTemplateMessageVariables();
`;
