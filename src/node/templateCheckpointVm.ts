/** 专属 QuickJS/WASM 堆的版本固定快照；只恢复本插件无宿主函数桥的静止 VM，绝不执行存档提供的宿主源码或 WASM。 */
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import type { QuickJSContext, QuickJSWASMModule } from 'quickjs-emscripten'
import { loadTemplateCheckpointEngine } from './templateCheckpointEngine.js'
import { templateCheckpointMemory } from './templateCheckpointMemory.js'
import { TEMPLATE_CHECKPOINT_ENGINE, TEMPLATE_CHECKPOINT_WASM_HASH, TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES,
  TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES,TEMPLATE_CHECKPOINT_COMPRESSED_MAX_BYTES,parseTemplateCheckpointVmImage,
  TEMPLATE_CHECKPOINT_PAGE_BYTES,TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES,
  type TemplateCheckpointVmImage,type TemplateCheckpointVmHandles } from '../core/templateCheckpoint.js'

export interface TemplateCheckpointVm {engine:QuickJSWASMModule;vm:QuickJSContext}
interface VmBridge {
  ctx:{value:number}
  uint32Out:{value:{ptr:number}}
  _BigInt?:unknown
  _Symbol?:unknown
  _SymbolIterator?:unknown
  _SymbolAsyncIterator?:unknown
  memory:{scope:{_disposables:{value:Set<unknown>}}}
  runtime:{rt:{value:number};contextMap:Map<number,unknown>;context:unknown;moduleLoader?:unknown;moduleNormalizer?:unknown;
    hostRefs:{groups:Map<unknown,unknown>;nextId:number;freelist:unknown[]}}
}
interface EngineBridge {callbacks:{contextCallbacks:Map<number,unknown>;runtimeCallbacks:Map<number,unknown>}}
interface Owner {engine:QuickJSWASMModule;stackPointer:()=>unknown;handles:TemplateCheckpointVmHandles}
const owners=new WeakMap<QuickJSContext,Owner>()
const STACK_POINTER=5333088
/** 精确 ABI 的全部 imports。堆摘要只校完整性；任意伪造 C 指针也不能借表内包装器取得宿主副作用。 */
const IMPORT_NAMES='abcdefghijklmnopqrst'.split('')
const FORBIDDEN_IMPORTS=new Set('bcghjlqrst'.split(''))
const ZERO_PAGE=new Uint8Array(TEMPLATE_CHECKPOINT_PAGE_BYTES)
let compiled:Promise<WebAssembly.Module>|undefined

function checkpointImports(module:WebAssembly.Module,imports:WebAssembly.Imports):WebAssembly.Imports {
  const definitions=WebAssembly.Module.imports(module),namespace=imports.a
  if(definitions.length!==IMPORT_NAMES.length||Object.keys(imports).length!==1||!namespace
    ||Object.keys(namespace).length!==IMPORT_NAMES.length||IMPORT_NAMES.some(name=>!Object.hasOwn(namespace,name))
    ||definitions.some(item=>item.module!=='a'||!IMPORT_NAMES.includes(item.name)||item.kind!==(item.name==='a'?'memory':'function'))
    ||!(namespace.a instanceof WebAssembly.Memory)
    ||IMPORT_NAMES.some(name=>name!=='a'&&typeof namespace[name]!=='function'))throw new Error('模板检查点 WASM 导入布局不兼容')
  const restricted={...namespace}
  // b/q 原实现会解码断言指针并打印；c/j/l/r 是输出/定时器/退出，g/h/s/t 是模板禁用的宿主桥。
  for(const name of FORBIDDEN_IMPORTS)restricted[name]=()=>{throw new Error(name==='b'||name==='q'
    ?'模板检查点引擎内部错误（断言或内存异常）':'模板检查点禁止宿主副作用')}
  return {a:restricted}
}

/** 从随插件保留的受信 v1 引擎编译；依赖更新不替换旧检查点所需的 WASM、胶水层或包装器。 */
async function prepare():Promise<WebAssembly.Module> {
  const {wasmBytes}=await loadTemplateCheckpointEngine()
  return WebAssembly.compile(wasmBytes)
}
export async function prepareTemplateCheckpointVm():Promise<void> {await (compiled ??= prepare())}

function handles(vm:QuickJSContext):TemplateCheckpointVmHandles {
  const bridge=vm as unknown as VmBridge
  // global 必须在任何动态输入或业务求值前分配；其余四个原始值指向固定静态区。
  return {runtime:bridge.runtime.rt.value,context:bridge.ctx.value,uint32:bridge.uint32Out.value.ptr,global:vm.global.value,
    undefined:vm.undefined.value,null:vm.null.value,false:vm.false.value,true:vm.true.value}
}
function sameHandles(left:TemplateCheckpointVmHandles,right:TemplateCheckpointVmHandles):boolean {
  return (Object.keys(left) as Array<keyof TemplateCheckpointVmHandles>).every(key=>left[key]===right[key])
}
function assertOwned(owner:TemplateCheckpointVm):Owner {
  const internal=owners.get(owner.vm)
  if(!internal||internal.engine!==owner.engine||!owner.vm.alive)throw new Error('模板检查点 VM 归属无效')
  const bridge=owner.vm as unknown as VmBridge,engine=owner.engine as unknown as EngineBridge
  if(bridge.runtime.contextMap.size!==1||bridge.runtime.context!==owner.vm||engine.callbacks.contextCallbacks.size!==1||engine.callbacks.runtimeCallbacks.size!==1
    ||bridge.runtime.hostRefs.groups.size!==0||bridge.runtime.hostRefs.nextId!==-2147483648||bridge.runtime.hostRefs.freelist.length!==0
    ||bridge.runtime.moduleLoader!==undefined||bridge.runtime.moduleNormalizer!==undefined)throw new Error('模板检查点不允许额外上下文或宿主函数桥')
  if(bridge._BigInt!==undefined||bridge._Symbol!==undefined||bridge._SymbolIterator!==undefined||bridge._SymbolAsyncIterator!==undefined
    ||bridge.memory.scope._disposables.value.size!==4||!sameHandles(internal.handles,handles(owner.vm)))throw new Error('模板检查点包装器句柄布局已改变')
  // 内部 Promise/async jobs 及悬挂帧都在此专属 C 堆；保留原队列，不能提前 drain 改变脚本时序。
  // 静止要求没有正在执行的 C 栈；受控调用方不使用 newPromise/resolvePromise 宿主异步桥。
  // hostRefs 检查和受限 imports 另行拒绝函数桥，不能把队列非空误当成外部 I/O。
  if(internal.stackPointer()!==STACK_POINTER)throw new Error('模板检查点必须在 C 栈静止点创建')
  return internal
}

export async function createTemplateCheckpointVm(value?:TemplateCheckpointVmImage):Promise<TemplateCheckpointVm> {
  const image=value===undefined ? undefined : parseTemplateCheckpointVmImage(value)
  const module=await (compiled ??= prepare())
  const {newQuickJSWASMModule,newVariant,RELEASE_SYNC}=await loadTemplateCheckpointEngine()
  const memory=new WebAssembly.Memory({initial:(image?.memoryBytes ?? TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES)/65536,maximum:TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES/65536})
  let exports:WebAssembly.Exports|undefined
  let rejectInstantiation!:(error:unknown)=>void
  const failed=new Promise<never>((_resolve,reject)=>{rejectInstantiation=reject})
  const engine=await Promise.race([newQuickJSWASMModule(newVariant(RELEASE_SYNC,{wasmMemory:memory,
    emscriptenModule:{instantiateWasm:(imports,onSuccess)=> {
      try {
        void WebAssembly.instantiate(module,checkpointImports(module,imports)).then(instance=>{exports=instance.exports;onSuccess(instance)},rejectInstantiation)
      } catch(error) {rejectInstantiation(error)}
      return {}
    }},
  })),failed])
  const stackPointer=exports?.Oa
  // Oa 是此精确 WASM SHA 的 stackSave 导出；唯一可变 global 为 i32 栈指针，静止值必须匹配。
  if(typeof stackPointer!=='function'||stackPointer()!==STACK_POINTER)throw new Error('模板检查点 WASM 栈布局不兼容')
  const vm=engine.newContext(),layout=handles(vm),owner={engine,vm}
  owners.set(vm,{engine,stackPointer:()=>stackPointer(),handles:layout})
  let memoryReplaced=false
  try {
    assertOwned(owner)
    if(image) {
      if(!sameHandles(layout,image.handles))throw new Error('模板检查点句柄与当前引擎不兼容')
      const destination=new Uint8Array(memory.buffer),digest=createHash('sha256')
      // 新模块的静态区、栈和初始 context 已经写过；这些页的 null 必须真正清空。
      // allocator 确认可用末端之后仍是新建 WASM 内存的零区，可跳过重复写零。
      const freshUsedBytes=templateCheckpointMemory(destination)?.segmentEnd ?? destination.length
      for(let index=0;index<image.payload.length;index++) {
        const payload=image.payload[index]!,offset=index*TEMPLATE_CHECKPOINT_PAGE_BYTES
        if(payload===null) {
          memoryReplaced=true
          if(offset<freshUsedBytes)destination.fill(0,offset,offset+TEMPLATE_CHECKPOINT_PAGE_BYTES)
          digest.update(ZERO_PAGE)
          continue
        }
        const compressed=Buffer.from(payload,'base64')
        if(compressed.length>TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES||compressed.toString('base64')!==payload)throw new Error('模板检查点 base64 正文无效')
        let bytes:Buffer
        try {bytes=gunzipSync(compressed,{maxOutputLength:TEMPLATE_CHECKPOINT_PAGE_BYTES})} catch {throw new Error('模板检查点解压失败或超限')}
        if(bytes.length!==TEMPLATE_CHECKPOINT_PAGE_BYTES)throw new Error('模板检查点解压页长度无效')
        digest.update(bytes)
        memoryReplaced=true
        destination.set(bytes,offset)
      }
      if(digest.digest('hex')!==image.memoryHash)throw new Error('模板检查点内存正文与摘要不一致')
      assertOwned(owner)
    }
    return owner
  } catch(error) {
    // 解压中途失败时不能拿部分替换的 C 堆调用析构；直接交由外层销毁 worker/WASM 实例。
    if(!memoryReplaced)vm.dispose()
    throw error
  }
}

/** 只读取内存与固定 FFI 状态，不调用 variables/schema，也不执行任何第三方脚本。 */
export function dumpTemplateCheckpointVm(owner:TemplateCheckpointVm):TemplateCheckpointVmImage {
  const internal=assertOwned(owner),memory=owner.engine.getWasmMemory()
  if(memory.buffer.byteLength>TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES)throw new Error('模板检查点内存超过资源容量')
  const bytes=new Uint8Array(memory.buffer),digest=createHash('sha256'),payload:Array<string|null>=[]
  const layout=templateCheckpointMemory(bytes),memoryBytes=layout?.memoryBytes ?? bytes.length
  const ranges=layout?.zeroRanges(),patches=layout?.patches ?? [],scratch=new Uint8Array(TEMPLATE_CHECKPOINT_PAGE_BYTES)
  const scratchView=new DataView(scratch.buffer)
  let range=ranges?.next()
  let compressedBytes=0,patchIndex=0
  for(let offset=0;offset<memoryBytes;offset+=TEMPLATE_CHECKPOINT_PAGE_BYTES) {
    const end=offset+TEMPLATE_CHECKPOINT_PAGE_BYTES
    let page=bytes.subarray(offset,end),copied=false
    while(range&&!range.done&&range.value[0]<end) {
      const [start,stop]=range.value
      if(stop>offset) {
        if(!copied){scratch.set(page);page=scratch;copied=true}
        page.fill(0,Math.max(start,offset)-offset,Math.min(stop,end)-offset)
      }
      if(stop<=end)range=ranges!.next()
      else break
    }
    while(patchIndex<patches.length&&patches[patchIndex]![0]<end) {
      const [address,value]=patches[patchIndex++]!
      if(!copied){scratch.set(page);page=scratch;copied=true}
      scratchView.setUint32(address-offset,value,true)
    }
    digest.update(page)
    const words=new Uint32Array(page.buffer,page.byteOffset,page.byteLength/4)
    let zero=true
    for(const word of words)if(word!==0){zero=false;break}
    if(zero){payload.push(null);continue}
    const compressed=gzipSync(page,{level:1})
    compressedBytes+=compressed.length
    if(compressed.length>TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES||compressedBytes>TEMPLATE_CHECKPOINT_COMPRESSED_MAX_BYTES)throw new Error('模板检查点压缩正文超过资源容量')
    payload.push(compressed.toString('base64'))
  }
  return {version:2,engine:TEMPLATE_CHECKPOINT_ENGINE,wasmHash:TEMPLATE_CHECKPOINT_WASM_HASH,memoryBytes,memoryHash:digest.digest('hex'),payload,handles:{...internal.handles}}
}
