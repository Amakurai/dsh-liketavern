/** EJS 在 QuickJS/WASM 中执行；不向脚本提供 Node、网络、DOM、宿主函数或模块加载器。 */
import { getQuickJS } from 'quickjs-emscripten'
import type { QuickJSContext } from 'quickjs-emscripten'
import { parseDocument } from 'yaml'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { TEMPLATE_HELPERS } from './templateHelpers.js'
import { TEMPLATE_WORLD_INFO } from './templateWorldInfo.js'
import { TEMPLATE_REGEX } from './templateRegex.js'
import { TEMPLATE_SCHEMA } from './templateSchema.js'
import { TEMPLATE_ASSETS } from './templateAssets.js'
import { TEMPLATE_FAKER } from './templateFaker.js'
import { TEMPLATE_REPLAY } from './templateReplay.js'
import { TEMPLATE_CONTEXT } from './templateContext.js'
import { TEMPLATE_OUTLETS } from './templateOutlets.js'
import { TEMPLATE_EJS } from './templateEjs.js'
import { TEMPLATE_DISPLAY } from './templateDisplay.js'
import { TEMPLATE_MESSAGE_VARIABLES } from './templateMessageVariables.js'
import { TEMPLATE_CONTINUATION } from './templateContinuation.js'
import type { TemplateReplayBootstrap } from '../core/templateContinuation.js'
import { parseTemplateStickyState, type TemplateStickyState } from '../core/templateSticky.js'
import type { TemplateRegexSource } from './templateRegexSources.js'
import { parseTemplateMessageIdentities, parseTemplateMessageVariables, type TemplateMessageVariables } from '../core/templateMessageVariables.js'
import { TEMPLATE_REPLAY_LIMIT, type TemplateReplay, type TemplateReplayOperation, type TemplateReplayInstruction } from '../core/templateReplay.js'
import { normalizeTemplateLore } from '../core/templateLore.js'
import { parseTemplateScopes, validateTemplateJson, type TemplateContext, type TemplateScopes, type TemplateRegexDescriptor, type TemplateMessageMetadata } from '../core/template.js'

let templateLibrarySource: string | undefined
let templateFakerSource: string | undefined

/** 本段是沙箱内的 JavaScript 源码，不在宿主执行；所有外部数据经 JSON 复制进去。 */
const BOOTSTRAP = String.raw`
const input = JSON.parse(__input);
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
let preparing = false;
function getvar(key, opts = {}) {
  opts = options(opts);
  if (opts.scope==='message' && opts.withMsg) return getHistoricalVariable(key,opts);
  let value = get(tree(opts.scope==='message' ? 'cache' : opts.scope || 'cache'), key, opts.defaults);
  if (opts.index != null) value = get(value, opts.index, opts.defaults);
  return opts.clone ? clone(value) : value;
}
function setvar(key, value, opts = {}) {
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
${TEMPLATE_FAKER}
${TEMPLATE_MESSAGE_VARIABLES}
${TEMPLATE_CONTEXT}
${TEMPLATE_REPLAY}
${TEMPLATE_CONTINUATION}
${TEMPLATE_DISPLAY}
`;

export class TemplateSandbox {
  private readonly renderedSources = new Map<string, string>()
  private readonly vm: QuickJSContext
  private readonly deadline: number
  private initialContext!:TemplateContext
  private bootstrap?:TemplateReplayBootstrap
  private recording=false
  private operations:TemplateReplayOperation[]=[]
  private operationChars=0
  private constructor(vm: QuickJSContext, deadline: number) { this.vm = vm; this.deadline = deadline }
  /** 仅预热受信任的 WASM 模块；不解析或执行第三方输入。 */
  static async prepare(): Promise<void> {
    await Promise.all([getQuickJS(),
      readFile(new URL('../../lib/vendor/template-libraries.js',import.meta.url),'utf8').then(source=>{templateLibrarySource=source}),
      readFile(new URL('../../lib/vendor/template-faker.js',import.meta.url),'utf8').then(source=>{templateFakerSource=source}),
    ])
  }

  private static normalizeContext(input:TemplateContext):TemplateContext {
    if(input.historyIdentities) parseTemplateMessageIdentities(input.historyIdentities,input.history.length)
    if(input.messageVariables) {
      parseTemplateMessageVariables(input.messageVariables)
      const visible=new Set(input.historyIdentities?.map(item=>item.messageId) ?? input.history.map((_,index)=>`preview:${index}`))
      if(Object.keys(input.messageVariables.snapshots).some(id=>!visible.has(id))) throw new Error('模板包含不可见消息变量')
    }
    // YAML 解析同样发生在可终止 worker；不注册自定义 tag，限制别名展开，拒绝循环与非 JSON。
    return { ...input, entries: input.entries.map(normalizeTemplateLore).map(entry => {
      if (!entry.enabled || !/^\[InitialVariables\]/i.test(entry.comment)) return entry
      const doc = parseDocument(entry.content, { uniqueKeys: true })
      if (doc.errors.length || doc.warnings.length) throw new Error(`InitialVariables 解析失败：${doc.errors[0]?.message ?? doc.warnings[0]?.message}`)
      const value: unknown = doc.toJS({ maxAliasCount: 50 })
      validateTemplateJson(value)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('InitialVariables 必须是对象')
      return { ...entry, content: JSON.stringify(value) }
    }) }
  }

  static async create(input: TemplateContext, record=false, bootstrap?:TemplateReplayBootstrap): Promise<TemplateSandbox> {
    const initialContext=structuredClone(input)
    input=TemplateSandbox.normalizeContext(input)
    const engine = await getQuickJS()
    const vm = engine.newContext()
    vm.runtime.setMemoryLimit(32 * 1024 * 1024)
    vm.runtime.setMaxStackSize(512 * 1024)
    const deadline = Date.now() + 750
    vm.runtime.setInterruptHandler(() => Date.now() > deadline)
    const sandbox = new TemplateSandbox(vm, deadline)
    try {
      if (!templateLibrarySource) throw new Error('模板依赖产物缺失，请先运行 npm run build')
      if (!templateFakerSource) throw new Error('Faker 模板依赖产物缺失，请先运行 npm run build')
      const fakerSourceHandle=vm.newString(templateFakerSource)
      try { vm.setProp(vm.global,'__tavernFakerSource',fakerSourceHandle) } finally { fakerSourceHandle.dispose() }
      sandbox.evaluate(`globalThis.__input = ${JSON.stringify(JSON.stringify(input))};\n${BOOTSTRAP.replace('/* TEMPLATE_VENDOR */',()=>templateLibrarySource!)}`)
      if(bootstrap?.preload==='refresh') sandbox.sticky('restore',bootstrap.state)
      sandbox.preload(input)
      if(bootstrap?.preload==='preserve') sandbox.sticky('restore',bootstrap.state)
      sandbox.initialContext=initialContext
      sandbox.bootstrap=structuredClone(bootstrap)
      sandbox.recording=record
      return sandbox
    } catch (error) { vm.dispose(); throw error }
  }

  /** 重建同轮已执行的代码和词法环境；所有输入仍由 QuickJS 求值，每步校验确定性结果。 */
  static async restore(replay:TemplateReplay, context:TemplateContext):Promise<TemplateSandbox> {
    const sandbox=await TemplateSandbox.rebuild(replay)
    try {sandbox.resume(context);return sandbox}
    catch(error) {sandbox.dispose();throw error}
  }

  static async rebuild(replay:TemplateReplay):Promise<TemplateSandbox> {
    if(replay.version!==2) throw new Error('模板重放版本不兼容，需要完成或回滚旧版本楼层')
    if(replay.context.phase!=='generate' || !Array.isArray(replay.operations)
      || replay.operations.length>4096 || JSON.stringify(replay).length>TEMPLATE_REPLAY_LIMIT) throw new Error('模板重放记录无效或超限')
    const sandbox=await TemplateSandbox.create(replay.context,false,replay.bootstrap)
    try {
      for(const operation of replay.operations) {
        let result:unknown
        if(operation.kind==='render') result=sandbox.render(operation.text,operation.data,operation.source)
        else if(operation.kind==='regex') result=sandbox.transformRegex(operation.text,operation.stage,operation.meta)
        else if(operation.kind==='variables') result=sandbox.variables()
        else if(operation.kind==='outlets') result=sandbox.resolveOutlets(operation.text)
        else if(operation.kind==='deferOutlets') {sandbox.setOutletsDeferred(operation.value);result=null}
        else if(operation.kind==='phase') {sandbox.resume(operation.context,operation.refreshPreload);result=null}
        else if(operation.kind==='message') result=sandbox.setMessageContext(operation.metadata)
        else if(operation.kind==='format') result=sandbox.formatMessage(operation.text)
        else if(operation.kind==='messageVariables') result=sandbox.messageVariables()
        else if(operation.kind==='sticky') result=sandbox.sticky(operation.action,operation.state)
        else throw new Error('未知模板重放操作')
        if(sandbox.hash(result)!==operation.hash) throw new Error('模板重放结果不一致，拒绝提交回复')
      }
      if(JSON.stringify(sandbox.variables())!==JSON.stringify(replay.variables)) throw new Error('模板重放最终变量不一致')
      if(sandbox.hash(sandbox.messageVariables())!==replay.messageVariablesHash) throw new Error('模板重放历史消息变量不一致')
      sandbox.operations=structuredClone(replay.operations)
      sandbox.operationChars=JSON.stringify(replay.operations).length
      sandbox.recording=true
      return sandbox
    } catch(error) {sandbox.dispose();throw error}
  }

  private hash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
  private record(operation:TemplateReplayInstruction,result:unknown):void {
    if(!this.recording) return
    const stored={...structuredClone(operation),hash:this.hash(result)} as TemplateReplayOperation
    this.operationChars+=JSON.stringify(stored).length
    if(this.operations.length>=4096 || this.operationChars>TEMPLATE_REPLAY_LIMIT) throw new Error('模板重放记录超过上限')
    this.operations.push(stored)
  }
  replay():TemplateReplay {
    const variables=this.variables()
    const replay:TemplateReplay={version:2,context:this.initialContext,operations:this.operations,variables,messageVariablesHash:this.hash(this.messageVariables()),
      ...(this.bootstrap ? {bootstrap:this.bootstrap} : {})}
    if(JSON.stringify(replay).length>TEMPLATE_REPLAY_LIMIT) throw new Error('模板重放快照超过 4 MiB 上限')
    return JSON.parse(JSON.stringify(replay)) as TemplateReplay
  }

  private evaluate(code: string): unknown {
    const result = this.vm.evalCode(code)
    if (result.error) {
      const error: unknown = this.vm.dump(result.error)
      result.error.dispose()
      throw new Error(`EJS 模板失败：${JSON.stringify(error)}`)
    }
    try { return this.vm.dump(result.value) } finally { result.value.dispose() }
  }

  private preload(context:TemplateContext):void {
    const recording=this.recording;this.recording=false
    try {
      this.evaluate('__setPreparing(true)')
      for(const entry of context.entries.filter(e=>e.enabled && e.templatePreload).sort((a,b)=>a.order-b.order)) {
        if(!entry.templateCondition || this.condition(entry.templateCondition)) this.render(entry.content,{},entry.key)
      }
      this.evaluate('__setPreparing(false)')
    } finally {this.recording=recording}
  }

  resume(context:TemplateContext,refreshPreload=false):void {
    const normalized=TemplateSandbox.normalizeContext(context)
    if(context.phase==='generate') {
      this.evaluate(`__continueTemplateGeneration(${JSON.stringify(normalized)})`)
      this.renderedSources.clear()
      if(refreshPreload) this.preload(normalized)
    } else this.evaluate(`__resumeTemplateReply(${JSON.stringify(normalized)})`)
    this.record({kind:'phase',context,refreshPreload},null)
  }

  stickyState():TemplateStickyState {
    const raw=this.evaluate('__exportTemplateStickyState()')
    if(typeof raw!=='string') throw new Error('sticky 导出无效')
    return parseTemplateStickyState(JSON.parse(raw))
  }

  sticky(action:'begin'|'finish'|'restore',state?:TemplateStickyState):TemplateStickyState {
    if(action==='restore') {
      if(!state) throw new Error('sticky 恢复缺少状态')
      this.evaluate(`__restoreTemplateStickyState(${JSON.stringify(parseTemplateStickyState(state))})`)
    } else this.evaluate(action==='begin'?'__beginTemplateGeneration()':'__finishTemplateGeneration()')
    const result=this.stickyState()
    this.record({kind:'sticky',action,...(state ? {state} : {})},result)
    return result
  }

  render(text: string, data: Record<string,unknown> = {}, source?:string): string {
    this.evaluate(`globalThis.__done=false; globalThis.__error=null; globalThis.__result=null;
      __render(${JSON.stringify(text)},__sourceData(${JSON.stringify(source) ?? 'undefined'},${JSON.stringify(data)})).then(v=>{globalThis.__result=v;globalThis.__done=true},e=>{globalThis.__error=String(e);globalThis.__done=true}); undefined;`)
    while (this.vm.runtime.hasPendingJob()) {
      if (Date.now() > this.deadline) throw new Error('EJS 模板计算超时')
      const result = this.vm.runtime.executePendingJobs(1)
      if (result.error) {
        const error: unknown = this.vm.dump(result.error)
        result.error.dispose()
        throw new Error(`EJS 异步任务失败：${JSON.stringify(error)}`)
      }
    }
    if (Date.now() > this.deadline) throw new Error('EJS 模板计算超时')
    if (!this.evaluate('__done')) throw new Error('EJS 异步任务未完成（不允许外部 I/O）')
    const error = this.evaluate('__error')
    if (error) throw new Error(`EJS 模板失败：${String(error)}`)
    const value = this.evaluate('__result')
    if (typeof value !== 'string' || value.length > 1024 * 1024) throw new Error('EJS 输出无效或超过 1 MiB')
    this.record({kind:'render',text,data,source},value)
    return value
  }

  /** 重组同轮计划时只重放已求值的来源，避免 activewi 引起脚本重复写变量。 */
  renderSource(text: string, source: string, data: Record<string,unknown> = {}): string {
    if (this.renderedSources.has(source)) return this.renderedSources.get(source)!
    const value = this.render(text,data,source)
    this.renderedSources.set(source,value)
    return value
  }
  activationRequests(): Array<{key:string;force:boolean}> {
    const raw = this.evaluate('__activationRequests()')
    if (typeof raw !== 'string') throw new Error('模板激活请求无效')
    return JSON.parse(raw) as Array<{key:string;force:boolean}>
  }
  transformRegex(text: string, stage: 'generate'|'message'|'after', meta: {role:string;worldinfo:boolean;depth:number}): string {
    const result = this.evaluate(`__applyTemporaryRegex(${JSON.stringify(text)},${JSON.stringify(stage)},${JSON.stringify(meta)})`)
    if (typeof result !== 'string') throw new Error('临时正则返回值无效')
    this.record({kind:'regex',text,stage,meta},result)
    return result
  }
  transformRegexSources(parts:TemplateRegexSource[],stage:'basic'|'generate'|'message'|'after',meta:{role:string;worldinfo:boolean;depth:number},cacheNamespace:string):TemplateRegexSource[] {
    const value:unknown=JSON.parse(this.render('<%- JSON.stringify(__applyTemporaryRegexSources(__tavernParts,__tavernStage,__tavernMeta,__tavernNamespace)) %>',
      {__tavernParts:parts,__tavernStage:stage,__tavernMeta:meta,__tavernNamespace:cacheNamespace}))
    if(!Array.isArray(value) || value.length>4096) throw new Error('正则来源结果超过 4096 段上限')
    let size=0
    for(const part of value) {
      if(!part || typeof part!=='object' || typeof part.key!=='string' || part.key.length>4096 || typeof part.text!=='string'
        || !Number.isSafeInteger(part.start) || part.start<0 || Object.keys(part).some(key=>!['key','text','start'].includes(key))) throw new Error('正则来源结果无效')
      size+=part.text.length
    }
    if(size>1024*1024) throw new Error('正则来源正文超过 1 MiB 上限')
    return value as TemplateRegexSource[]
  }
  regexDescriptors(): TemplateRegexDescriptor[] {
    const raw = this.evaluate('__regexDescriptors()')
    if (typeof raw !== 'string') throw new Error('临时正则描述无效')
    return JSON.parse(raw) as TemplateRegexDescriptor[]
  }
  hasMessageRegex(): boolean { return this.evaluate('__hasMessageRegex()') === true }

  formatMessage(text:string):string {
    const result=this.evaluate(`__formatTemplateMessage(${JSON.stringify(text)})`)
    if(typeof result!=='string' || result.length>1024*1024) throw new Error('模板消息格式化输出无效或超过 1 MiB')
    this.record({kind:'format',text},result)
    return result
  }

  setMessageContext(metadata:TemplateMessageMetadata|null):{role:string;worldinfo:boolean;depth:number} {
    const result=this.evaluate(`__setTemplateMessageContext(${JSON.stringify(metadata)})`) as {role:string;worldinfo:boolean;depth:number}
    this.record({kind:'message',metadata},result)
    return result
  }

  setOutletsDeferred(value:boolean):void {
    this.evaluate(`__setTemplateOutletsDeferred(${JSON.stringify(value)})`)
    this.record({kind:'deferOutlets',value},null)
  }
  resolveOutlets(text:string):string {
    const result=this.evaluate(`__resolveTemplateOutlets(${JSON.stringify(text)})`)
    if(typeof result!=='string') throw new Error('模板注入出口返回无效')
    this.record({kind:'outlets',text},result)
    return result
  }

  variables(): TemplateScopes {
    const raw = this.evaluate('__export()')
    if (typeof raw !== 'string' || raw.length > 1024 * 1024) throw new Error('模板变量超过 1 MiB 上限')
    const result=parseTemplateScopes(JSON.parse(raw))
    this.record({kind:'variables'},result)
    return result
  }
  messageVariables():TemplateMessageVariables {
    const raw=this.evaluate('__exportMessageVariables()')
    if(typeof raw!=='string') throw new Error('消息变量导出无效')
    const result=parseTemplateMessageVariables(JSON.parse(raw))
    this.record({kind:'messageVariables'},result)
    return result
  }
  /** 条件在 WI 预算和分组前求值；拒绝写变量，避免预选阶段产生未提交或重复副作用。 */
  condition(expression: string): boolean {
    const before = this.evaluate('__conditionState()')
    const result = this.render(`<%- Boolean(${expression}) %>`)
    if (this.evaluate('__conditionState()') !== before) throw new Error('@@if 条件必须只读，不能修改变量')
    return result === 'true'
  }
  dispose(): void { this.vm.dispose() }
}
