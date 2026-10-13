/** 真正新 worker/WASM 的堆检查点回归；第三方闭包、正则与 Zod 全在 QuickJS 内执行，覆盖内存增长、反复恢复和损坏边界。 */
import { Worker } from 'node:worker_threads'
import { gzipSync } from 'node:zlib'
import { describe,expect,it } from 'vitest'
import { parseTemplateCheckpointVmImage,TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES,type TemplateCheckpointVmImage } from '../src/core/templateCheckpoint.js'

interface Result {image?:TemplateCheckpointVmImage;next?:unknown;before?:unknown;after?:unknown;grown?:number;interrupted?:boolean;boundary?:unknown;error?:string;memorySizes?:number[];mallocSizes?:number[];changedPages?:number[];compressedBytes?:number;imports?:string[];clock?:unknown;pending?:boolean;beforeDrain?:unknown;afterOne?:unknown;tailImage?:TemplateCheckpointVmImage;drained?:unknown;remaining?:boolean}
const workerSource=String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {registerHooks}=require('node:module');
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.startsWith(workerData.sourceRoot))return next(specifier.slice(0,-3)+'.ts',context);return next(specifier,context)}});
(async()=>{
  const {createTemplateCheckpointVm,dumpTemplateCheckpointVm}=await import(workerData.entry);
  const {readFile}=await import('node:fs/promises');
  let capturedImports;
  if(workerData.mode==='imports'){
    const instantiate=WebAssembly.instantiate;
    WebAssembly.instantiate=async(module,imports)=>{if(module instanceof WebAssembly.Module)capturedImports=imports.a;return instantiate(module,imports)};
  }
  let owner;
  try {
    owner=await createTemplateCheckpointVm(workerData.image);
    let deadline=Date.now()+10000;
    const bind=()=>{owner.vm.runtime.setMemoryLimit(128*1024*1024);owner.vm.runtime.setMaxStackSize(512*1024);owner.vm.runtime.setInterruptHandler(()=>Date.now()>deadline)};
    bind();
    const evalVm=code=>{const result=owner.vm.evalCode(code);if(result.error){const error=owner.vm.dump(result.error);result.error.dispose();throw Error(JSON.stringify(error))}try{return owner.vm.dump(result.value)}finally{result.value.dispose()}};
    if(workerData.mode==='imports'){
      const imports=['b','c','g','h','j','l','q','r','s','t'].map(name=>{
        try{capturedImports[name](0,100000,0,0,0);return name+':allowed'}catch(error){return name+':'+String(error)}
      });
      const clock=evalVm('[Date.UTC(2000,0,1),new Date(946684800000).getUTCFullYear(),Number.isFinite(new Date().getTimezoneOffset())]');
      parentPort.postMessage({imports,clock});return;
    }
    if(!workerData.image){
      evalVm(await readFile(new URL(workerData.vendor),'utf8'));
      evalVm('globalThis.fixture=(()=>{let n=3,checks=0;const shared={n:7},rx=/tok(en)?/gi,key={},weak=new WeakMap([[key,"weak"]]),map=new Map([["x",shared]]);const schema=__TavernTemplateLibraries.z.object({x:__TavernTemplateLibraries.z.number().transform(x=>{checks++;return x+n})});const bytes=new Uint8Array(20*1024*1024);bytes[0]=23;bytes[bytes.length-1]=91;let resolved=0;Promise.resolve(17).then(x=>resolved=x);return {read:()=>[n,checks],step(text){n++;return [text.replace(rx,()=>String(++shared.n)),schema.parse({x:2}),n,checks,weak.get(key),map.get("x")===shared,bytes[0],bytes.at(-1),resolved]},grow(){globalThis.extra=new Uint8Array(24*1024*1024);extra[extra.length-1]=78;return extra.at(-1)}}})()');
      while(owner.vm.runtime.hasPendingJob()){const result=owner.vm.runtime.executePendingJobs();if(result.error)throw Error('pending fixture job failed')}
    }
    if(workerData.mode==='host') {const fn=owner.vm.newFunction('host',()=>owner.vm.undefined);owner.vm.setProp(owner.vm.global,'host',fn);fn.dispose()}
    if(workerData.mode==='context') {const extra=owner.engine.newContext();try{dumpTemplateCheckpointVm(owner)}finally{extra.dispose()}}
    if(workerData.mode==='jobs'||workerData.mode==='jobs-tail'){
      if(!workerData.image)evalVm('globalThis.queued=(()=>{let count=0;const log=[];Promise.resolve().then(()=>{log.push("a:"+(++count));Promise.resolve().then(()=>log.push("tail:"+(++count)))});Promise.resolve().then(()=>log.push("b:"+(++count)));(async()=>{await 0;log.push("await:"+(++count));await 0;log.push("resume:"+(++count))})();return{log,read:()=>({count,log:[...log]})}})();undefined');
      const pending=owner.vm.runtime.hasPendingJob(),before=evalVm('queued.read()'),image=dumpTemplateCheckpointVm(owner),after=evalVm('queued.read()');
      const step=()=>{const result=owner.vm.runtime.executePendingJobs(1);if(result.error){const error=owner.vm.dump(result.error);result.error.dispose();throw Error(JSON.stringify(error))}};
      let beforeDrain,afterOne,tailImage;
      if(workerData.mode==='jobs'){
        evalVm('queued.log.push("sync");undefined');beforeDrain=evalVm('queued.read()');
        step();afterOne=evalVm('queued.read()');tailImage=dumpTemplateCheckpointVm(owner);
      }
      while(owner.vm.runtime.hasPendingJob())step();
      parentPort.postMessage({image,pending,before,after,beforeDrain,afterOne,tailImage,drained:evalVm('queued.read()'),remaining:owner.vm.runtime.hasPendingJob()});return;
    }
    if(workerData.mode==='repeat') {
      const memorySizes=[],mallocSizes=[],changedPages=[];let previous;
      for(let index=0;index<12;index++){
        evalVm('fixture.step("TOKEN")');
        const usage=owner.vm.runtime.computeMemoryUsage();try{mallocSizes.push(owner.vm.dump(usage).memory_used_size)}finally{usage.dispose()}
        const image=dumpTemplateCheckpointVm(owner);memorySizes.push(image.memoryBytes);
        if(previous)changedPages.push(image.payload.filter((page,at)=>page!==previous.payload[at]).length);previous=image;
        owner.vm.dispose();owner=await createTemplateCheckpointVm(image);deadline=Date.now()+10000;bind();
      }
      parentPort.postMessage({next:evalVm('fixture.step("TOKEN")'),memorySizes,mallocSizes,changedPages,compressedBytes:previous.payload.reduce((sum,page)=>sum+(page===null?0:Buffer.from(page,'base64').length),0)});return;
    }
    const before=evalVm('fixture.read()'),image=dumpTemplateCheckpointVm(owner),after=evalVm('fixture.read()');
    const next=evalVm('fixture.step("TOKEN token")'),grown=evalVm('fixture.grow()');
    deadline=Date.now()+10;let interrupted=false;try{evalVm('while(true){}')}catch(error){interrupted=String(error).includes('interrupted')}
    deadline=Date.now()+1000;
    parentPort.postMessage({image,before,after,next,grown,interrupted,boundary:evalVm('[typeof process,typeof require,typeof fetch]')});
  }catch(error){parentPort.postMessage({error:String(error)})}
  finally{try{owner?.vm.dispose()}catch{}}
})().catch(error=>parentPort.postMessage({error:String(error)}));
`
async function run(mode='normal',image?:TemplateCheckpointVmImage):Promise<Result> {
  return new Promise((resolve,reject)=> {
    const worker=new Worker(workerSource,{eval:true,workerData:{mode,image,entry:new URL('../src/node/templateCheckpointVm.ts',import.meta.url).href,
      sourceRoot:new URL('../src/',import.meta.url).href,vendor:new URL('../lib/vendor/template-libraries.js',import.meta.url).href},resourceLimits:{maxOldGenerationSizeMb:256}})
    const timer=setTimeout(()=>{void worker.terminate();reject(Error('检查点测试 worker 超时'))},20_000)
    worker.once('message',(value:Result)=>{clearTimeout(timer);void worker.terminate().then(()=>resolve(value),reject)})
    worker.once('error',error=>{clearTimeout(timer);reject(error)})
    worker.once('exit',code=>{if(code!==0)clearTimeout(timer)})
  })
}

describe('完整 QuickJS 堆检查点',()=> {
  it('即使堆指针选择内部函数包装器，定时器、退出、输出和宿主桥也先被导入边界拒绝',async()=> {
    const result=await run('imports')
    expect(result.error).toBeUndefined()
    expect(result.imports).toHaveLength(10)
    for(const attempt of result.imports!)expect(attempt).toMatch(/模板检查点(?:禁止宿主副作用|引擎内部错误)/)
    expect(result.clock).toEqual([946684800000,2000,true])
  },30000)

  it('新 worker 恢复真实闭包/正则/Zod/弱引用，内存继续增长且超时和宿主边界不变',async()=> {
    const first=await run()
    expect(first.error).toBeUndefined()
    expect(first.before).toEqual(first.after)
    expect(first.image!.memoryBytes).toBeGreaterThan(16*1024*1024)
    const restored=await run('normal',first.image)
    expect(restored.error).toBeUndefined()
    expect(restored.next).toEqual(first.next)
    expect(restored.grown).toBe(78)
    expect(restored.interrupted).toBe(true)
    expect(restored.boundary).toEqual(['undefined','undefined','undefined'])
    // 导出本身没有运行 schema，也没有推进共享闭包。
    expect(restored.before).toEqual(restored.after)
    expect(first.image!.version).toBe(2)
    expect(first.image!.payload).toContain(null)
    // 旧 v1 只有字符串页；同一个内存镜像换成旧编码仍须原样恢复。
    const zero=gzipSync(Buffer.alloc(65536),{level:1}).toString('base64')
    const legacy:TemplateCheckpointVmImage={...first.image!,version:1,payload:first.image!.payload.map(page=>page??zero)}
    const restoredLegacy=await run('normal',legacy)
    expect(restoredLegacy.error).toBeUndefined()
    expect(restoredLegacy.next).toEqual(first.next)
  },30000)

  it('反复快照与恢复不会累积包装器孤儿句柄，下一次闭包计数精确延续',async()=> {
    const result=await run('repeat')
    expect(result.error).toBeUndefined()
    expect(new Set(result.memorySizes).size).toBe(1)
    expect(result.mallocSizes!.at(-1)!-result.mallocSizes![0]!).toBeLessThan(4096)
    expect(Math.max(...result.changedPages!)).toBeLessThan(result.memorySizes![0]!/65536/4)
    expect(result.next).toEqual(['20',{x:18},16,13,'weak',true,23,91,17])
    console.info(JSON.stringify({fixture:'checkpoint-pages',rawBytes:result.memorySizes![0],compressedBytes:result.compressedBytes,changedPages:result.changedPages,memoryGrowth:result.mallocSizes!.at(-1)!-result.mallocSizes![0]!}))
  },30000)

  it('新 worker 原样恢复内部 Promise 队列和悬挂 await，只在原 drain 点按 FIFO 推进',async()=> {
    const original=await run('jobs')
    expect(original.error).toBeUndefined()
    expect(original.pending).toBe(true)
    expect(original.before).toEqual({count:0,log:[]})
    expect(original.after).toEqual(original.before)
    expect(original.beforeDrain).toEqual({count:0,log:['sync']})
    expect(original.afterOne).toEqual({count:1,log:['sync','a:1']})
    expect(original.drained).toEqual({count:5,log:['sync','a:1','b:2','await:3','tail:4','resume:5']})
    expect(original.remaining).toBe(false)

    const restored=await run('jobs',original.image)
    expect(restored.error).toBeUndefined()
    expect(restored.pending).toBe(true)
    expect(restored.before).toEqual(original.before)
    expect(restored.after).toEqual(original.before)
    expect(restored.afterOne).toEqual(original.afterOne)
    expect(restored.drained).toEqual(original.drained)
    // 再从已执行一个 job 的检查点启动第三个 worker；队列中新增的尾任务仍排在原待执行任务后。
    const tail=await run('jobs-tail',original.tailImage)
    expect(tail.error).toBeUndefined()
    expect(tail.pending).toBe(true)
    expect(tail.before).toEqual(original.afterOne)
    expect(tail.after).toEqual(original.afterOne)
    expect(tail.drained).toEqual(original.drained)
    expect(tail.remaining).toBe(false)
  },30000)

  it.each(['host','context'])('拒绝 %s 状态，避免保存宿主桥或兄弟 VM',async mode=> {
    const result=await run(mode)
    expect(result.error).toMatch(/宿主函数桥|额外上下文|静止点/)
    expect(result.image).toBeUndefined()
  },30000)

  it('先拒绝未知字段/容量/引擎，worker 再拒绝摘要、解压长度、句柄与编码损坏',async()=> {
    const {image}=await run()
    expect(image).toBeDefined()
    expect(()=>parseTemplateCheckpointVmImage({...image,extra:true})).toThrow(/结构/)
    expect(()=>parseTemplateCheckpointVmImage({...image,memoryBytes:TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES+65536})).toThrow(/容量/)
    expect(()=>parseTemplateCheckpointVmImage({...image,engine:'other'})).toThrow(/引擎/)
    expect(()=>parseTemplateCheckpointVmImage({...image,version:99})).toThrow(/引擎/)
    expect(()=>parseTemplateCheckpointVmImage({...image,version:1,payload:[null,...image!.payload.slice(1)]})).toThrow(/压缩页/)
    const oversized=gzipSync(Buffer.alloc(65537)).toString('base64')
    const variants=[{...image!,memoryHash:'0'.repeat(64)},{...image!,payload:[oversized,...image!.payload.slice(1)]},
      {...image!,handles:{...image!.handles,runtime:image!.handles.runtime+8}},
      {...image!,payload:['AAAA'+image!.payload[0]!.slice(4),...image!.payload.slice(1)]}]
    for(const damaged of variants)expect((await run('normal',damaged)).error).toMatch(/摘要|解压|句柄|正文/)
  },30000)
})
