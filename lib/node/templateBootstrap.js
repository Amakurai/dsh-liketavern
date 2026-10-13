/** 固定模板运行时的沙箱源码，仅作为文本交给 QuickJS；主线程可读取指纹而不装载或运行虚拟机。 */
import { TEMPLATE_HELPERS } from './templateHelpers.js';
import { TEMPLATE_WORLD_INFO } from './templateWorldInfo.js';
import { TEMPLATE_REGEX } from './templateRegex.js';
import { TEMPLATE_SCHEMA } from './templateSchema.js';
import { TEMPLATE_ASSETS } from './templateAssets.js';
import { TEMPLATE_FAKER } from './templateFaker.js';
import { TEMPLATE_REPLAY } from './templateReplay.js';
import { TEMPLATE_CONTEXT } from './templateContext.js';
import { TEMPLATE_OUTLETS } from './templateOutlets.js';
import { TEMPLATE_EJS } from './templateEjs.js';
import { TEMPLATE_DISPLAY } from './templateDisplay.js';
import { TEMPLATE_MESSAGE_VARIABLES } from './templateMessageVariables.js';
import { TEMPLATE_HELPER_MVU } from './templateHelperMvu.js';
import { TEMPLATE_CONTINUATION } from './templateContinuation.js';
import { TEMPLATE_RUNTIME_ABI } from '../core/templateRuntimeAbi.js';
export const BOOTSTRAP = String.raw `
// 协议标记属于这个已保存环境；后续升级恢复旧堆不重跑此段，也不替换其闭包实现。
Object.defineProperty(globalThis,'__tavernRuntimeAbi',{value:${JSON.stringify(TEMPLATE_RUNTIME_ABI)},writable:false,configurable:false});
const parseTemplateInput=JSON.parse;
const input = parseTemplateInput(__input);
globalThis.__input=undefined;
let templateOutputLimit=__tavernOutputLimit;
function validate(value, depth=0, seen=new Set()) {
  if (depth>48) throw Error('模板变量嵌套超过 48 层');
  if (value===null || typeof value==='string' || typeof value==='boolean') return;
  if (typeof value==='number' && Number.isFinite(value)) return;
  if (!value || typeof value!=='object' || seen.has(value)) throw Error('模板变量必须是无循环 JSON 值');
  seen.add(value);
  for (const [key,item] of Object.entries(value)) {
    if (['__proto__','prototype','constructor'].includes(key)) throw Error('禁止的变量路径');
    validate(item,depth+1,seen);
  }
  seen.delete(value);
}
const clone = value => { if (value===undefined) return undefined; validate(value); return JSON.parse(JSON.stringify(value)); };
const scopes = clone(input.variables);
const initial = {};
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
function path(key) {
  const parts = Array.isArray(key) ? key.map(String) : String(key).replace(/\[(["']?)([^\]"']+)\1\]/g, '.$2').split('.');
  if (parts.some(p => (!Array.isArray(key) && !p) || forbidden.has(p))) throw Error('禁止的变量路径');
  return parts;
}
function get(object, key, fallback) {
  if (key == null) return object;
  for (const part of path(key)) {
    if (object == null || !Object.hasOwn(Object(object), part)) return fallback;
    object = object[part];
  }
  return object === undefined ? fallback : object;
}
function set(object, key, value) {
  const parts = path(key);
  const last = parts.pop();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!object[part] || typeof object[part] !== 'object') object[part] = /^\d+$/.test(parts[i + 1] || last) ? [] : {};
    object = object[part];
  }
  object[last] = clone(value);
}
function merge(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return clone(source);
  for (const [key, value] of Object.entries(source)) {
    if (forbidden.has(key)) throw Error('禁止的变量路径');
    target[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value) : clone(value);
  }
  return target;
}
function equal(a,b) {
  if (a===b || Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!a || !b || typeof a!=='object' || typeof b!=='object' || Array.isArray(a)!==Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key)&&equal(a[key],b[key]));
}
for (const entry of input.entries.filter(e => e.enabled && /^\[InitialVariables\]/i.test(e.comment))) {
  const value = JSON.parse(entry.content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('InitialVariables 必须是 JSON 对象');
  merge(initial, value);
}
let variables = merge(merge(merge(clone(initial), scopes.global), scopes.local), scopes.message);
function options(value = {}) {
  if (typeof value === 'boolean') value = {dryRun:value};
  if (typeof value === 'string') {
    if (['global','local','message','cache','initial'].includes(value)) value = {scope:value};
    else if (['nx','xx','n','nxs','xxs'].includes(value)) value = {flags:value};
    else if (['old','new','fullcache'].includes(value)) value = {results:value};
    else throw Error('不支持的变量选项：' + value);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('变量选项必须是对象');
  const allowed = ['scope','flags','results','defaults','clone','index','merge','dryRun','noCache','inscope','outscope','min','max','withMsg'];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw Error('不支持的变量选项：' + key);
  if (value.scope && !['global','local','message','cache','initial'].includes(value.scope)) throw Error('不支持的变量作用域');
  for (const key of ['inscope','outscope']) if (value[key] && !['global','local','message','cache','initial'].includes(value[key])) throw Error('不支持的变量作用域');
  if (value.flags && !['nx','xx','n','nxs','xxs'].includes(value.flags)) throw Error('不支持的变量 flags');
  if (value.results && !['old','new','fullcache'].includes(value.results)) throw Error('不支持的变量 results');
  if (value.withMsg!==undefined) validateMessageFilter(value.withMsg);
  return value;
}
const tree = scope => scope === 'cache' ? variables : scope === 'initial' ? initial : scopes[scope];
${TEMPLATE_HELPER_MVU}
let preparing = false;
function getvar(key, opts = {}) {
  opts = options(opts);
  if (opts.scope==='message' && opts.withMsg) return getHistoricalVariable(key,opts);
  let value = get(mvuView(tree(opts.scope==='message' ? 'cache' : opts.scope || 'cache')), key, opts.defaults);
  if (opts.index != null) value = get(value, opts.index, opts.defaults);
  return opts.clone ? clone(value) : value;
}
function setvar(key, value, opts = {}) {
  mvuGuardWrite(key);
  if (validatingSchema) throw Error('变量校验期间不能修改变量');
  opts = options(opts);
  if (preparing && opts.dryRun) throw Error('预加载不支持 dryRun 强制持久化，请在生成或回复模板中写入');
  const scope = preparing ? 'cache' : opts.scope || 'message';
  if (opts.scope === 'initial') throw Error('initial 变量只读');
  if (scope === 'initial') throw Error('initial 变量只读');
  if (scope==='message' && opts.withMsg) return writeHistoricalVariable(key,value,opts,value===undefined);
  const target = clone(tree(scope));
  const old = clone(get(target, key));
  const exists = get(/s$/.test(opts.flags || '') ? target : variables, key) !== undefined;
  if ((/^nx/.test(opts.flags || '') && exists) || (/^xx/.test(opts.flags || '') && !exists)) return undefined;
  if (opts.index != null) {
    const indexed = clone(get(target, key, {}));
    set(indexed, opts.index, value);
    value = indexed;
  }
  if (opts.merge) value = merge(old && typeof old === 'object' ? old : {}, value);
  if (key == null) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('变量树必须是对象');
    value = checkVariableSchema(clone(value));
    if (scope !== 'cache') scopes[scope] = clone(value);
    variables = value;
  } else {
    set(target, key, value);
    const next = clone(variables);
    set(next, key, value);
    validate(target); validate(next);
    const checked = checkVariableSchema(next);
    copySchemaChanges(target,next,checked);
    if (scope !== 'cache') scopes[scope] = target;
    variables = checked;
    value = get(checked,key);
  }
  api.variables = variables;
  syncCurrentMessageVariables();
  rememberSchemaState();
  return opts.results === 'old' ? old : opts.results === 'fullcache' ? variables : value;
}
function incvar(key, amount = 1, opts = {}) {
  opts = options(opts);
  let value = Number(getvar(key, {scope:opts.inscope || 'cache', defaults:opts.defaults ?? 0, index:opts.index,withMsg:opts.withMsg})) + Number(amount);
  if (opts.min != null) value = Math.max(value, opts.min);
  if (opts.max != null) value = Math.min(value, opts.max);
  if (!Number.isFinite(value)) throw Error('数值变量必须有限');
  return setvar(key, value, {...opts, scope:opts.outscope || opts.scope || 'message'});
}
function delvar(key, index, opts = {}) {
  mvuGuardWrite(key);
  if (validatingSchema) throw Error('变量校验期间不能修改变量');
  if(index && typeof index==='object' && !Array.isArray(index)) {opts={...options(index),...options(opts)};index=opts.index;}
  else {opts=options(opts);index=index ?? opts.index;}
  opts={...opts};delete opts.index;
  if (opts.scope === 'initial') throw Error('initial 变量只读');
  if (preparing && opts.dryRun) throw Error('预加载不支持 dryRun 强制持久化');
  if (preparing) opts = {...opts,scope:'cache'};
  if (index != null) {
    let value = clone(getvar(key,{scope:opts.scope || 'cache',withMsg:opts.withMsg}));
    if (Array.isArray(value) || typeof value === 'string') {
      const at = Number(index);
      if (!Number.isInteger(at) || at<0 || at>=value.length) return undefined;
      if (Array.isArray(value)) value.splice(at,1); else value=value.slice(0,at)+value.slice(at+1);
    } else if (value && typeof value === 'object') {
      if (forbidden.has(String(index))) throw Error('禁止的变量路径');
      if (!Object.hasOwn(value,index)) return undefined;
      delete value[index];
    } else return undefined;
    return setvar(key, value, opts);
  }
  const scope = opts.scope || 'message';
  if(scope==='message' && opts.withMsg) return writeHistoricalVariable(key,undefined,opts,true);
  const target = clone(tree(scope)), old=clone(get(target,key));
  const exists = get(/s$/.test(opts.flags || '') ? target : variables,key)!==undefined;
  if ((/^nx/.test(opts.flags || '') && exists) || (/^xx/.test(opts.flags || '') && !exists)) return undefined;
  if(key==null) {
    const checked=checkVariableSchema({});
    if(scope!=='cache') scopes[scope]=clone(checked);
    variables=checked;api.variables=variables;
    syncCurrentMessageVariables();rememberSchemaState();
    return opts.results==='old' ? old : opts.results==='fullcache' ? variables : undefined;
  }
  const parts = path(key), last = parts.pop();
  const next=clone(variables);
  for (const root of [target, next]) {
    const parent = parts.length ? get(root, parts) : root;
    if (parent && typeof parent === 'object') delete parent[last];
  }
  const checked=checkVariableSchema(next);
  copySchemaChanges(target,next,checked);
  if (scope!=='cache') scopes[scope]=target;
  variables=checked; api.variables=variables;
  syncCurrentMessageVariables();
  rememberSchemaState();
  return opts.results==='old' ? old : opts.results==='fullcache' ? variables : undefined;
}
let seed = input.seed >>> 0;
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
// 原生构造器只留在闭包内；继承链或 prototype.constructor 也不能绕过轮初时钟。
(()=>{
  const NativeDate=Date;
  function FrozenDate(...args) {
    if(!new.target) return new NativeDate(input.now).toString();
    return Reflect.construct(NativeDate,args.length?args:[input.now],new.target);
  }
  FrozenDate.prototype=NativeDate.prototype;
  Object.defineProperty(FrozenDate.prototype,'constructor',{value:FrozenDate,writable:true,configurable:true});
  Object.assign(FrozenDate,{now:()=>input.now,parse:NativeDate.parse,UTC:NativeDate.UTC});
  globalThis.Date=FrozenDate;
})();
/* TEMPLATE_VENDOR */
const matches = (value, query) => query instanceof RegExp ? (query.lastIndex = 0, query.test(value)) : String(value) === String(query);
${TEMPLATE_EJS}
${TEMPLATE_ASSETS}
const api = {
  char:input.char, user:input.user, variables, initialVariables:initial, defines:{},
  charName:input.char, userName:input.user, runType:input.phase,
  is_user:false, is_system:false,
  chatId:input.sessionId, characterId:input.cardId, generateType:input.phase==='generate' ? input.generationType || 'normal' : '',
  charLoreBook:input.entries.find(e=>e.source==='character')?.sourceRef,
  userLoreBook:input.entries.find(e=>e.source==='persona')?.sourceRef,
  chatLoreBook:input.entries.find(e=>e.source==='chat')?.sourceRef,
  lastUserMessage:[...input.history].reverse().find(m=>m.role==='user')?.content || '',
  lastCharMessage:[...input.history].reverse().find(m=>m.role==='assistant')?.content || '',
  lastMessageId:input.history.length-1,
  getvar, setvar, incvar, decvar:(key,n=1,o={})=>incvar(key,-n,o), delvar,
  getwi, getWorldInfo:getwi, evalTemplate, parseJSON:JSON.parse,
  getCharData:getCharacterData, getCharaData:getCharacterData,
  getchar:getCharacterDefinition,
  async getpreset(name,data={}) { const p=input.presets.find(p=>matches(p.name,name)||matches(p.identifier,name)); return p ? assetIdentity(await evalTemplate(p.content,assetLocals(this,data))) : ''; },
  getWorldInfoData:async name=>clone(input.entries.filter(e=>!name||matches(e.sourceRef,name))),
  getEnabledWorldInfoEntries:async ()=>clone(input.entries.filter(e=>e.enabled)),
  getChatMessage:(index,role)=> { const m=input.history.at(index); return m && (!role||m.role===role) ? m.content : ''; },
  getChatMessages:(count,role)=>input.history.filter(m=>!role||m.role===role).slice(-count).map(m=>m.content),
  saveVariables:async ()=>{},
  _: {get,set,merge,cloneDeep:clone,has:(o,k)=>get(o,k)!==undefined,isEqual:equal,
      random:(min,max)=>{ if(max===undefined){max=min;min=0;}return Math.floor(Math.random()*(max-min+1))+min; }},
};
api.getChara = api.getchar;
let apiVariables=variables;
Object.defineProperty(api,'variables',{enumerable:true,configurable:false,get:()=>mvuView(apiVariables),set:value=>{apiVariables=value;}});
api.getchr = api.getchar;
api.getPresetPrompt = api.getpreset;
api.getprp = api.getpreset;
api.define = (name,value,combine=false)=> { path(name); api.defines[name]=combine ? merge(api.defines[name]||{},value) : value; api[name]=api.defines[name]; };
for (const scope of ['global','local','message']) {
  const title = scope[0].toUpperCase()+scope.slice(1);
  api['get'+title+'Var']=(key,opts={})=>getvar(key,{...options(opts),scope});
  api['set'+title+'Var']=(key,value,opts={})=>setvar(key,value,{...options(opts),scope});
  api['inc'+title+'Var']=(key,value=1,opts={})=>incvar(key,value,{...options(opts),outscope:scope});
  api['dec'+title+'Var']=(key,value=1,opts={})=>incvar(key,-value,{...options(opts),outscope:scope});
  api['del'+title+'Var']=(key,index,opts={})=>delvar(key,index,{...options(opts),scope});
}
globalThis.__render = evalTemplate;
globalThis.__scopes = scopes;
globalThis.__export = () => { validate(scopes); validate(variables); if(variableSchema && JSON.stringify(variables)!==schemaCacheState) checkVariableSchema(variables); if (variableSchema && JSON.stringify(scopes)!==schemaState) checkVariableSchema(merge(merge(merge(clone(initial),scopes.global),scopes.local),scopes.message)); return JSON.stringify(scopes); };
globalThis.__conditionState = () => JSON.stringify({scopes,variables,initial,messageSnapshots});
globalThis.__setPreparing = value => { prepareMessageVariables(value);preparing = value; api.runType = value ? 'preparation' : input.phase; };
${TEMPLATE_HELPERS}
${TEMPLATE_OUTLETS}
${TEMPLATE_WORLD_INFO}
${TEMPLATE_REGEX}
${TEMPLATE_SCHEMA}
const checkTemplateSchema=checkVariableSchema;
checkVariableSchema=value=>{
  const result=checkTemplateSchema(value);
  if(input.helperMvu && !equal(value.stat_data,result.stat_data)) throw Error('MVU stat_data 是只读快照，模板 schema 不能写入该字段');
  return result;
};
${TEMPLATE_FAKER}
${TEMPLATE_MESSAGE_VARIABLES}
${TEMPLATE_CONTEXT}
${TEMPLATE_REPLAY}
${TEMPLATE_CONTINUATION}
${TEMPLATE_DISPLAY}
`;
