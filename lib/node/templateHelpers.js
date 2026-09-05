/** 沙箱内的兼容 API 源码：JSON Patch、命名提示词与历史查询；所有脚本与正则仍由 QuickJS 限时执行。 */
export const TEMPLATE_HELPERS = String.raw `
function pointer(value) {
  if (typeof value !== 'string' || value !== '' && !value.startsWith('/')) throw Error('JSON Patch 路径必须是 JSON Pointer');
  if (value === '') return [];
  return value.slice(1).split('/').map(part => {
    if (/~[^01]|~$/.test(part)) throw Error('JSON Pointer 转义无效');
    const key = part.replace(/~1/g,'/').replace(/~0/g,'~');
    if (forbidden.has(key)) throw Error('禁止的变量路径');
    return key;
  });
}
function patchIndex(key, size, append=false) {
  if (append && key === '-') return size;
  if (!/^(0|[1-9]\d*)$/.test(key)) throw Error('JSON Patch 数组下标无效');
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index >= size + Number(append)) throw Error('JSON Patch 数组越界');
  return index;
}
function patchRead(root, parts) {
  for (const key of parts) {
    if (!root || typeof root !== 'object') throw Error('JSON Patch 路径不存在');
    if (Array.isArray(root)) patchIndex(key,root.length);
    if (!Object.hasOwn(root,key)) throw Error('JSON Patch 路径不存在');
    root = root[key];
  }
  return root;
}
function jsonPatch(dest, changes) {
  if (!Array.isArray(changes) || changes.length > 1024) throw Error('JSON Patch 必须是最多 1024 项的操作数组');
  let root = clone(dest);
  function edit(parts, operation, value) {
    if (!parts.length) {
      if (operation === 'remove') throw Error('JSON Patch 不支持删除整个 JSON 文档');
      root = clone(value); return;
    }
    const parent = patchRead(root,parts.slice(0,-1)), key = parts.at(-1);
    if (!parent || typeof parent !== 'object') throw Error('JSON Patch 父路径不是容器');
    if (Array.isArray(parent)) {
      const index = patchIndex(key,parent.length,operation==='add');
      if (operation==='add') parent.splice(index,0,clone(value));
      else if (operation==='remove') parent.splice(index,1);
      else parent[index] = clone(value);
    } else {
      if (operation !== 'add' && !Object.hasOwn(parent,key)) throw Error('JSON Patch 路径不存在');
      if (operation === 'remove') delete parent[key]; else parent[key] = clone(value);
    }
  }
  for (const change of changes) {
    if (!change || typeof change !== 'object') throw Error('JSON Patch 操作无效');
    const parts = pointer(change.path);
    switch (change.op) {
      case 'add': case 'replace':
        if (!Object.hasOwn(change,'value')) throw Error('JSON Patch 缺少 value');
        validate(change.value); edit(parts,change.op,change.value); break;
      case 'remove': edit(parts,'remove'); break;
      case 'test':
        if (!Object.hasOwn(change,'value')) throw Error('JSON Patch 缺少 value');
        validate(change.value);
        if (!equal(patchRead(root,parts),change.value)) throw Error('JSON Patch test 失败');
        break;
      case 'copy': case 'move': {
        const from = pointer(change.from), value = clone(patchRead(root,from));
        if (change.op === 'move') {
          if (from.length < parts.length && from.every((v,i)=>v===parts[i])) throw Error('JSON Patch 不能移入自身子节点');
          if (equal(from,parts)) break;
          edit(from,'remove');
        }
        edit(parts,'add',value); break;
      }
      default: throw Error('不支持的 JSON Patch 操作：'+change.op);
    }
  }
  validate(root);
  return root;
}
function patchVariables(key, changes, opts={}) {
  opts = options(opts);
  return setvar(key,jsonPatch(getvar(key,{scope:opts.scope || 'cache',...(opts.withMsg===undefined?{}:{withMsg:opts.withMsg})}),changes),opts);
}
function insvar(key, value, index, opts={}) {
  opts = options(opts);
  let old = clone(getvar(key,{scope:opts.scope || 'cache',...(opts.withMsg===undefined?{}:{withMsg:opts.withMsg})}));
  if (Array.isArray(old) || typeof old === 'string') {
    const at = index == null ? old.length : Number(index);
    if (!Number.isInteger(at) || at < 0 || at > old.length) return undefined;
    if (Array.isArray(old)) old.splice(at,0,clone(value));
    else old = old.slice(0,at)+String(value)+old.slice(at);
  } else if (old && typeof old === 'object' && index != null) {
    const part = String(index);
    if (forbidden.has(part)) throw Error('禁止的变量路径');
    old[part] = clone(value);
  } else return undefined;
  return setvar(key,old,opts);
}
const injections = new Map();
let injectionSize = 0;
let injectionCount = 0;
function injectPrompt(key, prompt, order=100, sticky=0, uid='') {
  stickyFinite(sticky);
  if (typeof key !== 'string' || typeof prompt !== 'string' || !Number.isFinite(order) || typeof uid !== 'string') throw Error('injectPrompt 参数无效');
  if (key.length>4096 || uid.length>4096) throw Error('注入提示词名称或 uid 超过 4096 字符上限');
  if (!injections.has(key) && injections.size>=1024) throw Error('注入提示词分组超过 1024 组上限');
  if (prompt.length>1024*1024) throw Error('注入提示词超过 1 MiB 上限');
  const group = injections.get(key) || new Map();
  const id=uid || stickyIdentity(key+'#'+prompt);
  if (!group.has(id) && group.size>=4096) throw Error('注入提示词分组超过 4096 条上限');
  if (!group.has(id) && injectionCount>=4096) throw Error('注入提示词总数超过 4096 条上限');
  const size=injectionSize-(group.get(id)?.prompt.length || 0)+prompt.length;
  if(size>1024*1024) throw Error('注入提示词总量超过 1 MiB 上限');
  if(!group.has(id))injectionCount++;
  group.set(id,{prompt,order,sticky}); injections.set(key,group); injectionSize=size;
  stickyTombstones.prompts.delete(JSON.stringify([key,id]));
}
function getPromptsInjected(key, postprocess=[], outlet=templateOutletsDeferred && !preparing) {
  if (typeof key!=='string' || key.length>4096 || !Array.isArray(postprocess) || typeof outlet!=='boolean') throw Error('getPromptsInjected 参数无效');
  // 与上游相同：带后处理时立即读取；仅无后处理的 outlet 在所有条目执行后展开。
  if (outlet && !postprocess.length) {
    if (!key || /[\r\n]/.test(key) || key.includes('}}')) throw Error('注入出口名称必须为非空单行且不能包含 }}');
    return '{{outletPromptsInjected:'+key+'}}';
  }
  let text = [...(injections.get(key)?.values() || [])].sort((a,b)=>a.order-b.order).map(p=>p.prompt).join('\n');
  if(text.length>1024*1024) throw Error('注入提示词总量超过 1 MiB 上限');
  for (const rule of postprocess) {
    text = text.replace(rule.search,rule.replace);
    if(text.length>1024*1024) throw Error('注入提示词后处理超过 1 MiB 上限');
  }
  return text;
}
function copyDefinition(value,context,depth=0,seen=new Set()) {
  if(depth>48) throw Error('模板定义嵌套超过 48 层');
  if(typeof value==='function') return context ? value.bind(context) : value;
  if(value===null || typeof value!=='object') return value;
  if(!Array.isArray(value) && !__TavernTemplateLibraries.lodash.isPlainObject(value)) return value;
  if(seen.has(value)) throw Error('模板定义不能包含循环引用');
  seen.add(value);
  const result=Array.isArray(value) ? [] : {};
  for(const key of Object.keys(value)) {
    if(forbidden.has(key)) throw Error('禁止的定义路径');
    result[key]=copyDefinition(value[key],context,depth+1,seen);
  }
  seen.delete(value);
  return result;
}
function defineTemplate(name,value,combine=false) {
  const lodash=__TavernTemplateLibraries.lodash;
  if(typeof name!=='string' || !name) throw Error('定义名称必须是非空字符串');
  const parts=lodash.toPath(name);
  if(parts.some(part=>forbidden.has(part))) throw Error('禁止的定义路径');
  const old=lodash.get(api.defines,parts), context=this || api;
  let next=copyDefinition(value,null);
  if(combine && Array.isArray(next) && (old===undefined || Array.isArray(old))) next=[...(old || []),...next];
  else if(combine && lodash.isPlainObject(next) && (old===undefined || lodash.isPlainObject(old))) {
    next=lodash.mergeWith({},old || {},next,(_left,right)=>Array.isArray(right) ? right : undefined);
  }
  lodash.set(api.defines,parts,next);
  const root=parts[0];
  api[root]=copyDefinition(api.defines[root],api);
  if(context!==api) context[root]=copyDefinition(api.defines[root],context);
  return old;
}
function bindDefinitions(context) {
  for(const key of Object.keys(api.defines)) {
    if(!Object.hasOwn(context,key)) context[key]=copyDefinition(api.defines[key],context);
  }
  return context;
}
globalThis.__bindTemplateDefinitions=bindDefinitions;
function getChatMessages(start=input.history.length, end, role) {
  if (!Number.isInteger(start) || typeof end==='number' && !Number.isInteger(end)) throw Error('消息下标必须是整数');
  if (typeof end !== 'number') role = end ?? role;
  const messages = input.history.filter(m=>!role || m.role===role);
  const selected = typeof end === 'number' ? messages.slice(start,end)
    : start<0 ? messages.slice(start) : messages.slice(0,start);
  return selected.map(m=>m.content);
}
function matchChatMessages(pattern, opts={}) {
  const messages = getChatMessages(opts.start ?? -2,opts.end ?? undefined,opts.role);
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return messages.some(text=> {
    const found = p=>p instanceof RegExp ? (p.lastIndex=0,p.test(text)) : text.includes(String(p));
    return opts.and ? patterns.every(found) : patterns.some(found);
  });
}
Object.assign(api,{jsonPatch,patchVariables,insvar,injectPrompt,getPromptsInjected,
  define:defineTemplate,hasPromptsInjected:key=>(injections.get(key)?.size || 0)>0,getChatMessages,matchChatMessages,
  getChatMessage:(index,role)=>input.history.filter(m=>!role || m.role===role).at(index)?.content || ''});
for (const scope of ['global','local','message']) {
  const title=scope[0].toUpperCase()+scope.slice(1);
  api['insert'+title+'Var']=(key,value,index,opts={})=>insvar(key,value,index,{...options(opts),scope});
}
`;
