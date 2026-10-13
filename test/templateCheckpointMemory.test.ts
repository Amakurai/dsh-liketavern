/** 分配器空闲内容只在快照副本消除；真实隔离 worker 验证旧/新编码恢复、闭包与待执行任务、再次大块分配，以及损坏布局保守回退。 */
import {Worker} from 'node:worker_threads'
import {describe,expect,it} from 'vitest'
import {templateCheckpointMemory} from '../src/node/templateCheckpointMemory.js'
import type {TemplateCheckpointVmImage} from '../src/core/templateCheckpoint.js'

interface Result {
  image?:TemplateCheckpointVmImage
  legacy?:TemplateCheckpointVmImage
  before?:unknown
  after?:unknown
  output?:unknown
  allocation?:number
  unchanged?:boolean
  stats?:{freeBytes:number;freeChunks:number;dirtyBytes:number;cleanBytes:number;zeroPages:number;rawBytes:number}
  error?:string
}
const workerSource=String.raw`
const{parentPort,workerData}=require('node:worker_threads');
const{registerHooks}=require('node:module');
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.startsWith(workerData.root))return next(specifier.slice(0,-3)+'.ts',context);return next(specifier,context)}});
(async()=>{
  const{createTemplateCheckpointVm,dumpTemplateCheckpointVm}=await import(workerData.entry);
  const{templateCheckpointMemory}=await import(workerData.memory);
  const{readFile}=await import('node:fs/promises');const{randomBytes,createHash}=await import('node:crypto');const{gzipSync}=await import('node:zlib');
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  let owner;
  try{
    owner=await createTemplateCheckpointVm(workerData.image);const vm=owner.vm;
    vm.runtime.setMemoryLimit(256*1024*1024);vm.runtime.setMaxStackSize(512*1024);
    const deadline=Date.now()+15000;vm.runtime.setInterruptHandler(()=>Date.now()>deadline);
    const evaluate=source=>{const result=vm.evalCode(source);if(result.error){const error=vm.dump(result.error);result.error.dispose();throw Error(JSON.stringify(error))}try{return vm.dump(result.value)}finally{result.value.dispose()}};
    const buffer=(key,bytes)=>{const handle=vm.newArrayBuffer(bytes);try{vm.setProp(vm.global,key,handle)}finally{handle.dispose()}};
    let image,legacy,stats,unchanged;
    if(!workerData.image){
      evaluate(await readFile(new URL(workerData.vendor),'utf8'));
      evaluate('globalThis.fixture=(()=>{let n=3,queued=0;const box={value:7},rx=/x/g,map=new Map([["a",box]]);const schema=__TavernTemplateLibraries.z.object({x:__TavernTemplateLibraries.z.number().transform(x=>x+n)});Promise.resolve().then(()=>queued=17);return{read:()=>[n,box.value,queued],step:()=>["xx".replace(rx,()=>String(++box.value)),schema.parse({x:++n}),map.get("a")===box,queued]}})();globalThis.anchors=[];globalThis.garbage=[]');
      for(const size of [2,8,3]){buffer('buffer',randomBytes(size*1024*1024));evaluate('garbage.push(buffer);buffer=undefined;anchors.push(new Uint8Array(16384).fill(91))')}
      buffer('topBuffer',randomBytes(16*1024*1024));evaluate('garbage=[];topBuffer=undefined;undefined');
      const bytes=new Uint8Array(owner.engine.getWasmMemory().buffer),beforeHash=sha(bytes),layout=templateCheckpointMemory(bytes);
      image=dumpTemplateCheckpointVm(owner);unchanged=beforeHash===sha(bytes);
      const payload=[];for(let offset=0;offset<bytes.length;offset+=65536)payload.push(gzipSync(bytes.subarray(offset,offset+65536),{level:1}).toString('base64'));
      legacy={...image,version:1,memoryBytes:bytes.length,memoryHash:beforeHash,payload};
      stats={freeBytes:layout?.freeBytes,freeChunks:layout?.freeChunks,dirtyBytes:payload.reduce((n,p)=>n+Buffer.from(p,'base64').length,0),cleanBytes:image.payload.reduce((n,p)=>n+(p===null?0:Buffer.from(p,'base64').length),0),zeroPages:image.payload.filter(p=>p===null).length,rawBytes:bytes.length};
    }
    const before=evaluate('fixture.read()');
    dumpTemplateCheckpointVm(owner);
    const after=evaluate('fixture.read()');
    while(vm.runtime.hasPendingJob()){const result=vm.runtime.executePendingJobs(1);if(result.error)throw Error('pending job failed')}
    const output=evaluate('[fixture.step(),anchors.map(a=>[a[0],a.at(-1),a.length])]');
    buffer('reused',randomBytes(30*1024*1024));const allocation=evaluate('new Uint8Array(reused).length');evaluate('reused=undefined;undefined');
    parentPort.postMessage({image,legacy,stats,unchanged,before,after,output,allocation});
  }catch(error){parentPort.postMessage({error:String(error)})}finally{try{owner?.vm.dispose()}catch{}}
})().catch(error=>parentPort.postMessage({error:String(error)}));
`
async function run(image?:TemplateCheckpointVmImage):Promise<Result> {
  return new Promise((resolve,reject)=> {
    const worker=new Worker(workerSource,{eval:true,workerData:{image,root:new URL('../src/',import.meta.url).href,
      entry:new URL('../src/node/templateCheckpointVm.ts',import.meta.url).href,memory:new URL('../src/node/templateCheckpointMemory.ts',import.meta.url).href,
      vendor:new URL('../lib/vendor/template-libraries.js',import.meta.url).href},resourceLimits:{maxOldGenerationSizeMb:384}})
    const timer=setTimeout(()=>{void worker.terminate();reject(Error('空闲内存检查点 worker 超时'))},20000)
    worker.once('message',(result:Result)=>{clearTimeout(timer);void worker.terminate().then(()=>resolve(result),reject)})
    worker.once('error',error=>{clearTimeout(timer);reject(error)})
  })
}

/** 最小手写分配器：live/free/live/top，前块末四字节与后块 prev_foot 共用，必须保留。 */
function arena():Uint8Array {
  const bytes=new Uint8Array(16*1024*1024),view=new DataView(bytes.buffer),set=(at:number,value:number)=>view.setUint32(at,value,true)
  const base=5333088,free=base+32,last=free+512,top=last+32,end=top+256+40
  set(86864,end);set(88268,512);set(88272,256);set(88276,base);set(88280,free);set(88284,top)
  set(88692,end-base);set(88708,base);set(88712,end-base)
  bytes.fill(71,base,end)
  set(base+4,35);set(free+4,513);set(last,512);set(last+4,34);set(top+4,257);set(top+256+4,40)
  return bytes
}

/** 有效单段在用大块不能因内容全零被裁去；仅 top 与 sbrk 以外的预增长空间可回收。 */
function grownArena(topOnly:boolean):Uint8Array {
  const bytes=new Uint8Array(20*1024*1024),view=new DataView(bytes.buffer),set=(at:number,value:number)=>view.setUint32(at,value,true)
  const base=5333088,end=18*1024*1024,top=topOnly?base+32:end-48,size=end-top-40
  set(86864,end);set(88272,size);set(88276,base);set(88284,top)
  set(88692,end-base);set(88696,end-base);set(88708,base);set(88712,end-base);set(88740,4096);set(88748,0xffffffff)
  set(base+4,(top-base)|3);set(top,0x75757575);set(top+4,size|1);set(top+size+4,40)
  return bytes
}

interface TrimAnchor {pointer:number;size:number}
interface TrimResult {
  image?:TemplateCheckpointVmImage
  legacy?:TemplateCheckpointVmImage
  anchor?:TrimAnchor
  business?:unknown
  rawBytes?:number
  restoredBytes?:number
  unchanged?:boolean
  error?:string
}
const trimWorkerSource=String.raw`
const{parentPort,workerData}=require('node:worker_threads');const{registerHooks}=require('node:module');
registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&specifier.endsWith('.js')&&context.parentURL?.startsWith(workerData.root))return next(specifier.slice(0,-3)+'.ts',context);return next(specifier,context)}});
(async()=>{
 const{createTemplateCheckpointVm,dumpTemplateCheckpointVm}=await import(workerData.entry);
 const{createHash}=await import('node:crypto');const{gzipSync}=await import('node:zlib');
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');let owner;
 try{
  owner=await createTemplateCheckpointVm(workerData.image);const vm=owner.vm,module=owner.engine.module;
  const restoredBytes=owner.engine.getWasmMemory().buffer.byteLength;
  vm.runtime.setMemoryLimit(128*1024*1024);vm.runtime.setMaxStackSize(512*1024);const deadline=Date.now()+15000;vm.runtime.setInterruptHandler(()=>Date.now()>deadline);
  const evaluate=source=>{const out=vm.evalCode(source);if(out.error){const error=vm.dump(out.error);out.error.dispose();throw Error(JSON.stringify(error))}try{return vm.dump(out.value)}finally{out.value.dispose()}};
  const raw=()=>Buffer.from(owner.engine.getWasmMemory().buffer);
  const allocate=(size,tag)=>{const pointer=module._malloc(size);if(!pointer)throw Error('fixture malloc failed');raw().fill(tag,pointer,pointer+size);return{pointer,size,tag}};
  const check=row=>{const bytes=raw();for(let i=0;i<row.size;i+=4096)if(bytes[row.pointer+i]!==row.tag)throw Error('live bytes changed');for(let i=Math.max(0,row.size-32);i<row.size;i++)if(bytes[row.pointer+i]!==row.tag)throw Error('live tail changed')};
  let anchor=workerData.anchor,business;
  if(!workerData.image){
   evaluate('globalThis.fixture=(()=>{let n=0,release;const shared={value:7},weak=new WeakRef(shared),map=new Map([["box",shared]]),key={},weakmap=new WeakMap([[key,shared]]);let candidate={};candidate.self=candidate;const weakCycle=new WeakRef(candidate),finals=[],registry=new FinalizationRegistry(value=>finals.push(value));registry.register(candidate,"cycle");candidate=undefined;const queue=[],waiting=new Promise(resolve=>{release=resolve});(async()=>{queue.push("start");await waiting;queue.push("await")})();Promise.resolve().then(()=>queue.push("first")).then(()=>queue.push("second"));return{read:()=>[n,queue.slice(),weak.deref()===shared,weakmap.get(key)===shared,map.get("box")===shared,Boolean(weakCycle.deref()),finals.slice(),typeof registry.register],release:()=>release(1),step:()=>[++n,++shared.value],queue:()=>Promise.resolve().then(()=>queue.push("cycle"))}})();undefined');
   // 此请求超过全部旧碎片，并使用后块 prev_foot 的有效四字节；快照不能覆盖它。
   anchor=allocate(8*1024*1024+4,117);
   if(raw().readUInt32LE(88284)!==anchor.pointer+anchor.size-4)throw Error('fixture anchor is not adjacent to top');
  }else{
   check({...anchor,tag:117});const before=evaluate('fixture.read()'),pendingBefore=vm.runtime.hasPendingJob();
   dumpTemplateCheckpointVm(owner);const after=evaluate('fixture.read()');
   let sum=0,rows=[];
   for(let i=0;i<400;i++){const row=allocate(128+(i*7919)%131072,1+i%250);rows.push(row);if(rows.length>24){const old=rows.shift();check(old);sum+=old.size;module._free(old.pointer)}}
   for(const row of rows){check(row);sum+=row.size;module._free(row.pointer)}
   const resized=evaluate('(()=>{let total=0;for(let pass=0;pass<4;pass++){const a=[];for(let i=0;i<12000;i++)a.push(i+pass);a.splice(2000,500);total+=a[10000];const bytes=new Uint8Array(3*1024*1024);total+=bytes[0]+bytes.at(-1)}return total})()');
   evaluate('fixture.release();undefined');let jobs=0;while(vm.runtime.hasPendingJob()){const out=vm.runtime.executePendingJobs(1);if(out.error){out.error.dispose();throw Error('pending job failed')}if(++jobs>100)throw Error('unbounded job fixture')}
   const step=evaluate('fixture.step()'),finished=evaluate('fixture.read()');evaluate('fixture.queue();undefined');check({...anchor,tag:117});
   business={before,after,pendingBefore,sum,resized,jobs,step,finished};
  }
  const peak=allocate(48*1024*1024,83),extra=allocate(4*1024*1024,91);module._free(extra.pointer);module._free(peak.pointer);
  check({...anchor,tag:117});const bytes=raw(),beforeHash=sha(bytes),image=dumpTemplateCheckpointVm(owner);
  const unchanged=sha(raw())===beforeHash,payload=[];for(let offset=0;offset<bytes.length;offset+=65536)payload.push(gzipSync(bytes.subarray(offset,offset+65536),{level:1}).toString('base64'));
  const legacy={...image,version:1,memoryBytes:bytes.length,memoryHash:beforeHash,payload};
  parentPort.postMessage({image,legacy,anchor,business,rawBytes:bytes.length,restoredBytes,unchanged});
 }catch(error){parentPort.postMessage({error:String(error)})}finally{try{owner?.vm.dispose()}catch{}}
})().catch(error=>parentPort.postMessage({error:String(error)}));
`
async function runTrim(image?:TemplateCheckpointVmImage,anchor?:TrimAnchor):Promise<TrimResult> {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(trimWorkerSource,{eval:true,workerData:{image,anchor,root:new URL('../src/',import.meta.url).href,
      entry:new URL('../src/node/templateCheckpointVm.ts',import.meta.url).href},resourceLimits:{maxOldGenerationSizeMb:384}})
    const timer=setTimeout(()=>{void worker.terminate();reject(Error('内存裁剪恢复 worker 超时'))},20000)
    worker.once('message',(result:TrimResult)=>{clearTimeout(timer);void worker.terminate().then(()=>resolve(result),reject)})
    worker.once('error',error=>{clearTimeout(timer);reject(error)})
  })
}

describe('检查点空闲堆整理',()=> {
  it('仅裁掉未领取的整页；全零在用大块与最小top仍按真实分配边界保留',()=>{
    const bytes=grownArena(false),before=bytes.slice(),layout=templateCheckpointMemory(bytes)!
    expect(layout).toBeDefined();expect(layout.memoryBytes).toBe(18*1024*1024);expect(layout.patches).toEqual([])
    expect(Buffer.from(bytes.buffer).equals(Buffer.from(before.buffer))).toBe(true)
    expect(templateCheckpointMemory(bytes.subarray(0,layout.memoryBytes))?.segmentEnd).toBe(layout.segmentEnd)
  })

  it('裁掉最高top后仍是有效分配器，保留最后活块尾字且不改变实时堆',()=>{
    const bytes=grownArena(true),before=bytes.slice(),layout=templateCheckpointMemory(bytes)!
    expect(layout).toBeDefined();expect(layout.memoryBytes).toBe(16*1024*1024)
    const copy=bytes.slice(0,layout.memoryBytes),view=new DataView(copy.buffer)
    for(const [start,end] of layout.zeroRanges())if(start<copy.length)copy.fill(0,start,Math.min(end,copy.length))
    for(const [offset,value] of layout.patches)view.setUint32(offset,value,true)
    expect(templateCheckpointMemory(copy)?.segmentEnd).toBe(copy.length)
    expect(view.getUint32(5333088+32,true)).toBe(0x75757575)
    expect(view.getUint32(88696,true)).toBe(new DataView(before.buffer).getUint32(88696,true))
    expect(Buffer.from(bytes.buffer).equals(Buffer.from(before.buffer))).toBe(true)
  })
  it('只改副本空闲payload，保留相邻活块尾字、树元数据和top尾部',()=> {
    const original=arena(),before=original.slice(),layout=templateCheckpointMemory(original)!
    expect(layout).toBeDefined()
    const copy=original.slice(),ranges=[...layout.zeroRanges()]
    for(const [start,end] of ranges)copy.fill(0,start,end)
    const base=5333088,free=base+32,last=free+512,top=last+32
    expect(Buffer.from(original.buffer).equals(Buffer.from(before.buffer))).toBe(true)
    expect(copy.subarray(base,free+32)).toEqual(original.subarray(base,free+32))
    expect(copy.subarray(free+32,last).every(value=>value===0)).toBe(true)
    expect(copy.subarray(last,top+32)).toEqual(original.subarray(last,top+32))
    expect(copy.subarray(top+256,layout.segmentEnd)).toEqual(original.subarray(top+256,layout.segmentEnd))
    expect(templateCheckpointMemory(copy)?.freeBytes).toBe(layout.freeBytes)
  })

  it('段、顶块、footer或相邻使用标志损坏时整批放弃整理，不猜测活对象边界',()=> {
    for(const offset of [86864,88272,88284,88692,88712,88716,5333088+4,5333088+32+512]) {
      const bytes=arena();new DataView(bytes.buffer).setUint32(offset,0xfffffff8,true)
      expect(templateCheckpointMemory(bytes)).toBeUndefined()
    }
    const bytes=arena(),view=new DataView(bytes.buffer)
    view.setUint32(5333088+32+512+4,35,true)
    expect(templateCheckpointMemory(bytes)).toBeUndefined()
  })

  it('29 MiB 已释放高熵正文不再挤满检查点，原VM与新旧编码的冷恢复及再次分配完全等价',async()=> {
    const first=await run()
    expect(first.error).toBeUndefined()
    expect(first.unchanged).toBe(true)
    expect(first.before).toEqual([3,7,0]);expect(first.after).toEqual(first.before)
    expect(first.stats!.freeBytes).toBeGreaterThan(29*1024*1024)
    expect(first.stats!.cleanBytes).toBeLessThan(first.stats!.dirtyBytes/5)
    expect(first.stats!.zeroPages).toBeGreaterThan(100)
    expect(first.image!.version).toBe(2);expect(first.legacy!.version).toBe(1)
    const clean=await run(first.image),legacy=await run(first.legacy)
    for(const restored of [clean,legacy]) {
      expect(restored.error).toBeUndefined()
      expect(restored.before).toEqual(first.before);expect(restored.after).toEqual(first.before)
      expect(restored.output).toEqual(first.output);expect(restored.allocation).toBe(30*1024*1024)
    }
    console.info(JSON.stringify({fixture:'checkpoint-free-payload',...first.stats}))
  },60000)

  it('真实top裁剪跨三次冷恢复保持WeakRef、微任务FIFO、闭包和相邻活块尾四字节，再增长分配等价',async()=>{
    const initial=await runTrim()
    expect(initial.error).toBeUndefined();expect(initial.unchanged).toBe(true)
    expect(initial.image!.memoryBytes).toBeLessThan(initial.rawBytes!-32*1024*1024)
    expect(initial.legacy!.memoryBytes).toBe(initial.rawBytes)
    let full=initial,trimmed=initial
    for(let round=0;round<3;round++){
      const oldImage=full.legacy!,newImage=trimmed.image!
      full=await runTrim(oldImage,initial.anchor);trimmed=await runTrim(newImage,initial.anchor)
      for(const result of [full,trimmed]){expect(result.error).toBeUndefined();expect(result.unchanged).toBe(true)}
      expect(full.restoredBytes).toBe(oldImage.memoryBytes);expect(trimmed.restoredBytes).toBe(newImage.memoryBytes)
      expect(trimmed.business).toEqual(full.business)
      expect(trimmed.business).toMatchObject({pendingBefore:true,step:[round+1,round+8]})
      if(round===0){
        const untouched=[0,['start'],true,true,true,true,[],'function']
        expect(trimmed.business).toMatchObject({before:untouched,after:untouched,
          finished:[1,['start','first','await','second'],true,true,true,true,[],'function']})
      }
    }
    console.info(JSON.stringify({fixture:'checkpoint-top-trim',warmBytes:initial.rawBytes,checkpointBytes:initial.image!.memoryBytes,restoredBytes:trimmed.restoredBytes}))
  },60000)
})
