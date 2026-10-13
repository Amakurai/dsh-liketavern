/** 固定引擎发布包回归；在没有 node_modules 的独立目录和新进程中验证只读预检、真实闭包堆恢复与安装损坏拒绝。 */
import { execFile } from 'node:child_process'
import { copyFile,mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { describe,expect,it } from 'vitest'

const execute=promisify(execFile)
const artifacts=['engine.js','engine.wasm','LICENSE','manifest.json'] as const
let bundledLoader:Promise<string>|undefined
const loader=()=>bundledLoader??=build({entryPoints:[fileURLToPath(new URL('../src/node/templateCheckpointEngine.ts',import.meta.url))],
  bundle:true,platform:'node',format:'esm',target:'node24',write:false}).then(result=>result.outputFiles[0]!.text)

// 该程序只读本测试生成的堆；所有 QuickJS 执行留在新子进程，不在 Vitest/宿主线程创建 VM。
const runner=String.raw`
import assert from 'node:assert/strict';
import {readFile,writeFile,unlink} from 'node:fs/promises';
import {builtinModules,registerHooks} from 'node:module';
import {assertTemplateCheckpointEngine,loadTemplateCheckpointEngine} from './src/node/engine-loader.mjs';
const mode=process.argv[2],builtins=new Set(builtinModules);let importedEngine=0;
registerHooks({resolve(specifier,context,next){
  if(!specifier.startsWith('.')&&!specifier.startsWith('file:')&&!specifier.startsWith('node:')&&!builtins.has(specifier))throw Error('external npm dependency forbidden: '+specifier);
  const resolved=next(specifier,context);
  if(resolved.url.includes('/node_modules/'))throw Error('node_modules access forbidden');
  if(resolved.url.endsWith('/engine.js')){importedEngine++;if(mode==='check')throw Error('readonly preflight executed engine');}
  return resolved;
}});
async function run(){
  if(mode==='repair'){
    const path=new URL('./lib/vendor/checkpoint-engine-v1/engine.wasm',import.meta.url),bytes=await readFile(path);
    await unlink(path);
    await assert.rejects(assertTemplateCheckpointEngine(),/引擎文件缺失/);
    await assert.rejects(loadTemplateCheckpointEngine(),/引擎文件缺失/);
    assert.equal(importedEngine,0);await writeFile(path,bytes);
    await assertTemplateCheckpointEngine();assert.equal(importedEngine,0);
    await loadTemplateCheckpointEngine();return {mode,importedEngine};
  }
  if(mode==='check'){await assertTemplateCheckpointEngine();return {mode,importedEngine};}
  const pinned=await loadTemplateCheckpointEngine();
  if(mode==='load')return {mode,importedEngine};
  const image=mode==='resume'?await readFile(new URL('./heap.bin',import.meta.url)):null;
  const compiled=await WebAssembly.compile(pinned.wasmBytes),memory=new WebAssembly.Memory({initial:(image?.length??16*1024*1024)/65536,maximum:12288});
  let fail;const rejected=new Promise((_resolve,reject)=>{fail=reject});
  const engine=await Promise.race([pinned.newQuickJSWASMModule(pinned.newVariant(pinned.RELEASE_SYNC,{wasmMemory:memory,emscriptenModule:{instantiateWasm(imports,onSuccess){
    const allowed={...imports.a};for(const name of 'bcghjlqrst')allowed[name]=()=>{throw Error('fixture forbids host bridge')};
    void WebAssembly.instantiate(compiled,{a:allowed}).then(instance=>onSuccess(instance),fail);return {};
  }}})),rejected]);
  const vm=engine.newContext();
  try{
    const handles={runtime:vm.runtime.rt.value,context:vm.ctx.value,uint32:vm.uint32Out.value.ptr,global:vm.global.value,
      undefined:vm.undefined.value,null:vm.null.value,false:vm.false.value,true:vm.true.value};
    const evaluate=code=>{const value=vm.unwrapResult(vm.evalCode(code));try{return vm.dump(value)}finally{value.dispose()}};
    if(mode==='seed'){
      assert.equal(evaluate('globalThis.box=(()=>{let count=40;return {next:()=>++count}})();box.next()'),41);
      await writeFile(new URL('./heap.bin',import.meta.url),new Uint8Array(memory.buffer));
      await writeFile(new URL('./handles.json',import.meta.url),JSON.stringify(handles));
      return {mode,closure:41,importedEngine};
    }
    assert.equal(mode,'resume');assert.deepEqual(handles,JSON.parse(await readFile(new URL('./handles.json',import.meta.url),'utf8')));
    new Uint8Array(memory.buffer).set(image);
    assert.equal(evaluate('box.next()'),42);assert.equal(evaluate('box.next()'),43);
    return {mode,closure:43,importedEngine};
  }finally{vm.dispose()}
}
try{console.log(JSON.stringify(await run()))}catch(error){console.log(JSON.stringify({mode,error:String(error),importedEngine}))}
`

async function fixture():Promise<string> {
  const root=await mkdtemp(join(tmpdir(),'tavern-fixed-engine-'))
  await mkdir(join(root,'src/node'),{recursive:true})
  await mkdir(join(root,'lib/vendor/checkpoint-engine-v1'),{recursive:true})
  await Promise.all([
    ...artifacts.map(file=>copyFile(new URL(`../vendor/checkpoint-engine-v1/${file}`,import.meta.url),join(root,'lib/vendor/checkpoint-engine-v1',file))),
    writeFile(join(root,'package.json'),'{"type":"module"}'),writeFile(join(root,'runner.mjs'),runner),
    loader().then(code=>writeFile(join(root,'src/node/engine-loader.mjs'),code)),
  ])
  return root
}
async function run(root:string,mode:string):Promise<{mode:string;closure?:number;importedEngine:number;error?:string}> {
  const result=await execute(process.execPath,[join(root,'runner.mjs'),mode],{cwd:root,windowsHide:true,timeout:15_000})
  return JSON.parse(result.stdout.trim())
}

describe('冻结的检查点 v1 引擎发布包',()=> {
  it('只读预检不执行引擎；无 npm 依赖的两个新进程延续同一个真实计数闭包',async()=> {
    const root=await fixture()
    try {
      expect(await run(root,'check')).toEqual({mode:'check',importedEngine:0})
      expect(await run(root,'seed')).toEqual({mode:'seed',closure:41,importedEngine:1})
      expect(await run(root,'resume')).toEqual({mode:'resume',closure:43,importedEngine:1})
    } finally {await rm(root,{recursive:true,force:true})}
  },30_000)

  it.each(['engine.js','engine.wasm','manifest.json'])('固定包缺少 %s 时预检及加载都明确拒绝',async file=> {
    const root=await fixture()
    try {
      await rm(join(root,'lib/vendor/checkpoint-engine-v1',file))
      for(const mode of ['check','load']) {
        const result=await run(root,mode)
        expect(result.error).toMatch(/引擎文件缺失/)
        expect(result.importedEngine).toBe(0)
      }
    } finally {await rm(root,{recursive:true,force:true})}
  },30_000)

  it('失败不冒充已验证缓存，修复固定包后同一宿主进程可以重新预检和加载',async()=> {
    const root=await fixture()
    try {expect(await run(root,'repair')).toEqual({mode:'repair',importedEngine:1})}
    finally {await rm(root,{recursive:true,force:true})}
  },30_000)

  it.each(['engine.js','engine.wasm','manifest.json'])('固定包 %s 损坏时在任何引擎代码运行前拒绝',async file=> {
    const root=await fixture(),path=join(root,'lib/vendor/checkpoint-engine-v1',file)
    try {
      if(file==='manifest.json')await writeFile(path,'{"version":1,"engine":"untrusted","files":{}}')
      else if(file==='engine.js')await writeFile(path,(await readFile(path,'utf8'))+'\nthrow Error("corrupt-code-executed");\n')
      else {const bytes=await readFile(path);bytes[0]=bytes[0]!^1;await writeFile(path,bytes)}
      for(const mode of ['check','load']) {
        const result=await run(root,mode)
        expect(result.error).toMatch(/引擎(?:清单损坏|文件校验失败)/)
        expect(result.error).not.toContain('corrupt-code-executed')
        expect(result.importedEngine).toBe(0)
      }
    } finally {await rm(root,{recursive:true,force:true})}
  },30_000)
})
