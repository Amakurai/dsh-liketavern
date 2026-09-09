/** QuickJS 内的 MVU 只读视图：代理仅叠加读取，绝不把助手数据合入模板 scopes、继承或导出。 */
export const TEMPLATE_HELPER_MVU = String.raw `
const mvuReadonlyCache=new WeakMap();
function mvuReadOnly(value) {
  if(!value || typeof value!=='object') return value;
  if(mvuReadonlyCache.has(value)) return mvuReadonlyCache.get(value);
  const reject=()=>{throw Error('MVU stat_data 是只读快照，请通过 Mvu 更新并提交变量');};
  const proxy=new Proxy(value,{
    get:(target,key,receiver)=>mvuReadOnly(Reflect.get(target,key,receiver)),
    getOwnPropertyDescriptor:(target,key)=>{const desc=Reflect.getOwnPropertyDescriptor(target,key);return desc && 'value' in desc ? {...desc,value:mvuReadOnly(desc.value)} : desc;},
    set:reject,deleteProperty:reject,defineProperty:reject,setPrototypeOf:reject,preventExtensions:reject,
  });
  mvuReadonlyCache.set(value,proxy);return proxy;
}
function mvuAt(index,inherit=true) {
  if(!input.helperMvu) return undefined;
  const identities=input.historyIdentities || [];
  for(let at=Math.min(index,identities.length-1);at>=0;at--) {
    const stat=input.helperMvu.snapshots[identities[at]?.messageId];
    if(stat!==undefined) return stat;
    if(!inherit) break;
  }
  return undefined;
}
function mvuCurrentIndex() {return typeof currentMessageIndex==='number' && currentMessageIndex>=0 ? currentMessageIndex : input.history.length-1;}
function mvuGuardWrite(key) {
  if(input.helperMvu && (key==null || path(key)[0]==='stat_data')) throw Error('MVU stat_data 是只读快照，不能在模板中修改或清空整树');
}
function mvuView(base,index,inherit=true) {
  if(!input.helperMvu || !base || typeof base!=='object') return base;
  const stat=index===undefined && input.helperMvu.current!==undefined ? input.helperMvu.current : mvuAt(index ?? mvuCurrentIndex(),inherit);
  return new Proxy(base,{
    get:(target,key,receiver)=>key==='stat_data' ? mvuReadOnly(stat!==undefined ? stat : Reflect.get(target,key,receiver)) : Reflect.get(target,key,receiver),
    has:(target,key)=>key==='stat_data' && stat!==undefined || Reflect.has(target,key),
    ownKeys:target=>stat!==undefined ? [...new Set([...Reflect.ownKeys(target),'stat_data'])] : Reflect.ownKeys(target),
    getOwnPropertyDescriptor:(target,key)=>{
      if(key==='stat_data' && stat!==undefined) return {value:mvuReadOnly(stat),enumerable:true,configurable:true,writable:false};
      const desc=Reflect.getOwnPropertyDescriptor(target,key);
      return key==='stat_data' && desc && 'value' in desc ? {...desc,value:mvuReadOnly(desc.value)} : desc;
    },
    set:(target,key,value,receiver)=>{if(key==='stat_data') mvuGuardWrite(key);return Reflect.set(target,key,value,receiver);},
    deleteProperty:(target,key)=>{if(key==='stat_data') mvuGuardWrite(key);return Reflect.deleteProperty(target,key);},
    defineProperty:(target,key,descriptor)=>{if(key==='stat_data') mvuGuardWrite(key);return Reflect.defineProperty(target,key,descriptor);},
    setPrototypeOf:()=>{throw Error('MVU 变量视图不能替换原型');},
    preventExtensions:()=>{throw Error('MVU 变量视图不能更改结构描述符');},
  });
}
function findMvuMessageVariables(key,end=input.history.length) {
  if(!input.helperMvu) return findMessageVariables(key,end);
  if(arguments.length<2 && input.helperMvu.current!==undefined && (key==null || path(key)[0]==='stat_data')) return mvuView(findMessageVariables(null));
  if(!Number.isSafeInteger(end)) throw Error('findVariables 消息边界必须是整数');
  const limit=end<0 ? Math.max(0,input.history.length+end) : Math.min(end,input.history.length);
  for(let index=limit-1;index>=0;index--) {
    const frame=snapshotAt(index),stat=mvuAt(index,false);
    const view=mvuView(frame?.values || {},index,false);
    if((frame || stat!==undefined) && (key==null || get(view,key,null)!=null)) return view;
  }
  return mvuView(initial,-1,false);
}
`;
