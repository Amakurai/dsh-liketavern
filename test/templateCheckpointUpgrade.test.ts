/** 真实旧运行时到新安装包的检查点恢复：独立 worker 生成旧堆，经文件系统与 WAL 继续闭包，过期后才换用当前运行时。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterEach, expect, it } from 'vitest'
import { TEMPLATE_RUNTIME_ABI } from '../src/core/templateRuntimeAbi.js'
import type { TemplateState } from '../src/state/template.js'

const LEGACY_HASH='77f29556bf365b33ddb9d006fc8ea78f6088c36fd3c464a0ef2c4c036dc0a3f1'
const PREVIOUS_HASH='14eb40ac012bfbbc29d615b5996315c2e2fc81f8a80f16b98a04b6651e2b384e'
const roots:string[]=[]
const QUERIES=96

/**
 * 复原旧正则源码、两行 bootstrap 差异与当时的 vendor；旧 hash 必须由真实旧源码计算，不能改检查点头冒充兼容。
 * markdown-it 15.0.3 安全升级后当前 vendor 已变，旧版 template-libraries.js 原文以压缩夹具保存
 * （取自升级前提交，LF），只在旧版 worker 里替换这一个文件的读取。
 */
const LEGACY_LIBRARIES=fileURLToPath(new URL('./templateLibrariesV055.fixture.js.gz',import.meta.url))
const PREVIOUS_REGEX=fileURLToPath(new URL('./templateRegexSourcesV059.fixture.txt',import.meta.url))
/** 从优化前真实源码生成旧堆，不能用当前实现冒充旧指纹。 */
const previousRegexLoader=String.raw`
{
  const {readFileSync}=require('node:fs'),{registerHooks}=require('node:module');
  const previousSource=readFileSync(${JSON.stringify(PREVIOUS_REGEX)},'utf8');
  registerHooks({load(url,context,next){
    const loaded=next(url,context);
    return url.endsWith('/node/templateRegexSources.ts')?{...loaded,source:previousSource}:loaded;
  }});
}
`
const legacyLoader=previousRegexLoader+String.raw`
{
  const fsp=require('node:fs/promises'),{readFileSync}=require('node:fs'),{gunzipSync}=require('node:zlib');
  const legacyLibraries=gunzipSync(readFileSync(${JSON.stringify(LEGACY_LIBRARIES)})).toString('utf8');
  const currentReadFile=fsp.readFile;
  fsp.readFile=function(path,...rest){
    const name=(path instanceof URL?path.pathname:String(path)).replaceAll('\\','/');
    if(name.endsWith('/lib/vendor/template-libraries.js'))return Promise.resolve(legacyLibraries);
    return currentReadFile.call(this,path,...rest);
  };
  require('node:module').syncBuiltinESMExports();
}
{
  const {registerHooks}=require('node:module');
  registerHooks({load(url,context,next){
    const loaded=next(url,context);
    if(!url.endsWith('/node/templateBootstrap.ts'))return loaded;
    const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8');
    const lines=source.split(/(?<=\n)/);
    const comment='// 协议标记属于这个已保存环境；后续升级恢复旧堆不重跑此段，也不替换其闭包实现。';
    const index=lines.findIndex(line=>line.trimEnd()===comment);
    if(index<0||!lines[index+1]?.startsWith("Object.defineProperty(globalThis,'__tavernRuntimeAbi',"))throw Error('旧版本工厂的两行源码差异已变化');
    lines.splice(index,2);
    return {...loaded,source:lines.join('')};
  }});
}
`

/** define、回调和全局别名共享循环对象；捕获的运行时 helper 与 Promise 队列都必须仍属于原来的堆。 */
function template(start:number,tag:string):string {
  return `<%
    if(!getGlobalVar('registered-${tag}')) {
      setGlobalVar('registered-${tag}',true);
      setGlobalVar('inheritedHeap-${tag}',typeof globalThis.upgradeBox!=='undefined');
      const helper=getChatMessage,box={count:${start},events:[]};box.self=box;
      globalThis.upgradeBox=box;
      define('next',()=>{
        const count=++box.count;box.events.push('sync:'+count);
        Promise.resolve().then(()=>box.events.push('micro:'+count));
        return String(count);
      });
      define('inspectUpgrade',()=>JSON.stringify({count:box.count,helper:helper(0),
        shared:box===globalThis.upgradeBox && box.self===box,events:box.events.slice(-4),
        abi:typeof globalThis.__tavernRuntimeAbi==='undefined'?null:globalThis.__tavernRuntimeAbi}));
      activateRegex(/T[O]KEN/g,()=>String(++box.count),{uuid:'${tag}',message:true,sticky:2});
    }
  %>ROOT`
}

interface Observation {count:number;helper:string;shared:boolean;events:string[];abi:string|null}
interface Result {
  runtimeHash:string
  checkpointHash:string
  checkpointAbi?:string
  inputCheckpointHash?:string
  inputCheckpointAbi?:string
  initialCheckpoint:boolean
  operations:number
  first:string
  last:string
  observation:Observation
  reply:string[]
  sticky:string[]
  inheritedHeap:boolean
  error?:string
}

/** 每个阶段都终止整个 Node worker；真实 compute worker 的 loader 也复原旧源码，避免仅在外层算出旧 hash。 */
const workerSource=String.raw`
const workerThreads=require('node:worker_threads');
const {parentPort,workerData}=workerThreads;
const {registerHooks,syncBuiltinESMExports,stripTypeScriptTypes}=require('node:module');
registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.startsWith(workerData.sourceRoot))return next(specifier.slice(0,-3)+'.ts',context);
  return next(specifier,context);
},load(url,context,next){
  const loaded=next(url,context);
  // 文件存储通常由 Vitest 转译；专用 Node worker 仅为它开启参数属性转换，实际 compute worker 仍按原本的类型剥离装载。
  if(!url.startsWith(workerData.sourceRoot+'state/')||!url.endsWith('.ts'))return loaded;
  const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8');
  return {...loaded,format:'module',source:stripTypeScriptTypes(source,{mode:'transform'})};
}});
if(workerData.mode==='legacy') {
  const NativeWorker=workerThreads.Worker;
  workerThreads.Worker=class extends NativeWorker {
    constructor(source,options) {
      if(options?.eval&&options.workerData?.entry?.endsWith('/computeWorker.ts'))source=workerData.legacyLoader+'\n'+source;
      super(source,options);
    }
  };
  syncBuiltinESMExports();
}
(async()=>{
  const moduleAt=path=>import(new URL(path,workerData.sourceRoot).href);
  const [{defaultPreset},{emptyTemplateScopes},{emptyTemplateMessageVariables,visibleTemplateMessageVariables},{templateReplayLatestContext},
    {isolated,disposeIdleComputeWorkers},{loadTemplateRuntime},{loadTemplateState,saveTemplateState},{WorkspaceFs},{Wal}]=await Promise.all([
    moduleAt('core/assemble.ts'),moduleAt('core/template.ts'),moduleAt('core/templateMessageVariables.ts'),moduleAt('core/templateReplay.ts'),
    moduleAt('node/isolated.ts'),moduleAt('node/templateRuntime.ts'),moduleAt('state/template.ts'),moduleAt('state/workspaceFs.ts'),moduleAt('state/wal.ts')
  ]);
  const {writeFile}=require('node:fs/promises'),{join}=require('node:path');
  const runtimeHash=(await loadTemplateRuntime()).hash;
  if(workerData.mode==='legacy'&&runtimeHash!==workerData.legacyHash)throw Error('旧源码指纹未还原：'+runtimeHash);
  if(workerData.mode!=='legacy'&&runtimeHash===workerData.legacyHash)throw Error('当前安装包仍加载了旧源码');
  const wal=new Wal(join(workerData.root,'state/wal')),fs=new WorkspaceFs(workerData.root,wal);
  const checkpoint=state=>{
    const value=state.continuation?.replay?.checkpoint;
    if(!value)throw Error('真实业务调用未生成检查点');
    return value;
  };
  function request() {
    const preset=defaultPreset();
    preset.entries=preset.entries.filter(entry=>['main','chatHistory'].includes(entry.identifier));
    preset.entries.find(entry=>entry.identifier==='main').content=workerData.script;
    const history=[{role:'user',content:'captured-old-helper'}];
    const templates={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{name:'Alice'},entries:[],presets:preset.entries,
      history,historyIdentities:[{messageId:'user',swipeId:0}],messageVariables:emptyTemplateMessageVariables(),now:1000,seed:42,
      phase:'generate',sessionId:'checkpoint-upgrade',cardId:'factory-card'};
    return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
      macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},templates};
  }
  const assembledState=result=>({version:1,variables:result.templateVariables,messageVariables:result.templateMessageVariables,outputs:{},
    continuation:{...result.templateContinuation,replay:result.templateReplay}});
  const renderedState=result=>({version:1,variables:result.variables,messageVariables:result.messageVariables,outputs:{},continuation:result.templateContinuation});
  async function assemble(state) {
    const input=request();
    if(state){input.templates.variables=state.variables;input.templates.messageVariables=visibleTemplateMessageVariables(state.messageVariables,input.templates.historyIdentities);input.templateContinuation=state.continuation;}
    return assembledState(await isolated('assemble',input));
  }
  async function advance(state) {
    const {replay,...continuation}=state.continuation;
    const context={...templateReplayLatestContext(replay),phase:'generate',variables:state.variables,messageVariables:state.messageVariables};
    const result=await isolated('template',{texts:[...Array.from({length:workerData.queries},()=>'<%- next() %>'),'<%- inspectUpgrade() %>'],
      context,replay,templateContinuation:continuation});
    return {state:renderedState(result),first:result.texts[0],last:result.texts[workerData.queries-1],observation:JSON.parse(result.texts.at(-1))};
  }
  async function reply(state) {
    const {replay,...continuation}=state.continuation,previous=templateReplayLatestContext(replay),index=previous.history.length;
    const context={...previous,phase:'render',variables:state.variables,messageVariables:state.messageVariables,
      history:[...previous.history,{role:'assistant',content:'TOKEN TOKEN'}],
      historyIdentities:[...previous.historyIdentities,{messageId:'reply-'+workerData.mode,swipeId:0}],renderMessages:[{index,role:'assistant',swipeId:0}]};
    const result=await isolated('template',{texts:['TOKEN TOKEN'],decorateOutput:true,context,replay,templateContinuation:continuation});
    return {state:renderedState(result),texts:result.texts};
  }
  try {
    let state,inputCheckpointHash,inputCheckpointAbi;
    if(workerData.mode==='legacy') {
      // 第二次真实组装把 sticky 从 2 推进至 1，证明导出的是跨轮存活环境；再下一轮开始时它才过期。
      state=await assemble(await assemble());
    } else {
      state=await loadTemplateState(new WorkspaceFs(workerData.root,null));
      inputCheckpointHash=checkpoint(state).runtimeHash;inputCheckpointAbi=checkpoint(state).runtimeAbi;
      if(workerData.mode==='fresh')state=await assemble(state);
    }
    const initialCheckpoint=Boolean(state.continuation.replay?.checkpoint);
    const advanced=await advance(state),generated=checkpoint(advanced.state);
    const rendered=await reply(advanced.state);state=rendered.state;
    // 最早的旧版本没有 ABI 头；后续版本保留它实际声明的 ABI。
    if(workerData.mode==='legacy'&&!workerData.legacyHasAbi)delete checkpoint(state).runtimeAbi;
    await wal.beginFloor(workerData.floor);
    await saveTemplateState(fs.withFloor(workerData.floor),state);
    await wal.commitFloor(workerData.floor);
    if(workerData.mode==='legacy')await writeFile(workerData.exportPath,JSON.stringify(state),'utf8');
    parentPort.postMessage({runtimeHash,checkpointHash:generated.runtimeHash,checkpointAbi:generated.runtimeAbi,inputCheckpointHash,inputCheckpointAbi,
      initialCheckpoint,operations:advanced.state.continuation.replay.operations.length,first:advanced.first,last:advanced.last,observation:advanced.observation,reply:rendered.texts,
      sticky:state.continuation.state.regex.message.map(rule=>rule.uuid),inheritedHeap:state.variables.global['inheritedHeap-'+workerData.tag]});
  } finally {await disposeIdleComputeWorkers()}
})().catch(error=>parentPort.postMessage({error:error.stack||String(error)}));
`

async function run(mode:'legacy'|'resume'|'fresh',root:string,exportPath:string,fixture:'legacy'|'previous'):Promise<Result> {
  const old=mode==='legacy',fresh=mode==='fresh'
  const sourceLoader=fixture==='legacy'?legacyLoader:previousRegexLoader
  const legacyHash=fixture==='legacy'?LEGACY_HASH:PREVIOUS_HASH
  return new Promise((resolve,reject)=> {
    const worker=new Worker((old?sourceLoader:'')+'\n'+workerSource,{eval:true,workerData:{mode,root,exportPath,legacyHash,
      legacyLoader:sourceLoader,legacyHasAbi:fixture==='previous',sourceRoot:new URL('../src/',import.meta.url).href,queries:QUERIES,script:template(fresh?1000:0,fresh?'current':'legacy'),
      tag:fresh?'current':'legacy',floor:old?'story#t1':fresh?'story#t3':'story#t2'},resourceLimits:{maxOldGenerationSizeMb:512}})
    let settled=false
    const timer=setTimeout(()=>{settled=true;void worker.terminate();reject(Error('运行时升级测试 worker 超时'))},45000)
    worker.once('message',(value:Result)=>{settled=true;clearTimeout(timer);void worker.terminate().then(()=>resolve(value),reject)})
    worker.once('error',error=>{settled=true;clearTimeout(timer);reject(error)})
    worker.once('exit',code=>{clearTimeout(timer);if(!settled)reject(Error(`运行时升级测试 worker 在返回结果前退出：${code}`))})
  })
}

afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})

it.each([
  {fixture:'legacy' as const,hash:LEGACY_HASH,abi:null},
  {fixture:'previous' as const,hash:PREVIOUS_HASH,abi:TEMPLATE_RUNTIME_ABI},
])('真实旧代码堆 $fixture 经新安装包冷恢复并保留旧身份，闭包到期后才切换当前运行时',async({fixture,hash,abi})=> {
  const root=await mkdtemp(join(tmpdir(),'tavern-checkpoint-upgrade-'));roots.push(root)
  const workspace=join(root,'story'),exportPath=join(root,'legacy.json')
  const legacy=await run('legacy',workspace,exportPath,fixture)
  expect(legacy.error).toBeUndefined()
  expect(legacy.runtimeHash).toBe(hash)
  expect(legacy.checkpointHash).toBe(hash)
  expect(legacy.initialCheckpoint).toBe(false)
  expect(legacy.operations).toBeLessThan(256)
  expect([legacy.first,legacy.last]).toEqual(['1','96'])
  expect(legacy.observation).toEqual({count:96,helper:'captured-old-helper',shared:true,abi,
    events:['sync:95','micro:95','sync:96','micro:96']})
  expect(legacy.reply).toEqual(['97 98'])
  expect(legacy.sticky).toEqual(['legacy'])
  expect(legacy.inheritedHeap).toBe(false)
  const exported=JSON.parse(await readFile(exportPath,'utf8')) as TemplateState
  expect(exported.continuation!.replay!.checkpoint!.runtimeHash).toBe(hash)
  expect(exported.continuation!.replay!.checkpoint!.runtimeAbi).toBe(abi??undefined)

  const resumed=await run('resume',workspace,exportPath,fixture)
  expect(resumed.error).toBeUndefined()
  expect(resumed.runtimeHash).not.toBe(hash)
  expect(resumed.inputCheckpointHash).toBe(hash)
  expect(resumed.inputCheckpointAbi).toBe(abi??undefined)
  expect(resumed.initialCheckpoint).toBe(true)
  expect(resumed.operations).toBeLessThan(256)
  expect(resumed.checkpointHash).toBe(hash)
  expect(resumed.checkpointAbi).toBe(TEMPLATE_RUNTIME_ABI)
  expect([resumed.first,resumed.last]).toEqual(['99','194'])
  expect(resumed.observation).toEqual({count:194,helper:'captured-old-helper',shared:true,abi,
    events:['sync:193','micro:193','sync:194','micro:194']})
  expect(resumed.reply).toEqual(['195 196'])
  expect(resumed.sticky).toEqual(['legacy'])

  const fresh=await run('fresh',workspace,exportPath,fixture)
  expect(fresh.error).toBeUndefined()
  expect(fresh.runtimeHash).toBe(resumed.runtimeHash)
  expect(fresh.inputCheckpointHash).toBe(hash)
  expect(fresh.inputCheckpointAbi).toBe(TEMPLATE_RUNTIME_ABI)
  expect(fresh.initialCheckpoint).toBe(false)
  expect(fresh.operations).toBeLessThan(256)
  expect(fresh.checkpointHash).toBe(fresh.runtimeHash)
  expect(fresh.checkpointAbi).toBe(TEMPLATE_RUNTIME_ABI)
  expect([fresh.first,fresh.last]).toEqual(['1001','1096'])
  expect(fresh.observation).toEqual({count:1096,helper:'captured-old-helper',shared:true,abi:TEMPLATE_RUNTIME_ABI,
    events:['sync:1095','micro:1095','sync:1096','micro:1096']})
  expect(fresh.reply).toEqual(['1097 1098'])
  expect(fresh.sticky).toEqual(['current'])
  expect(fresh.inheritedHeap).toBe(false)
},120000)
