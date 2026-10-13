/** 固定 QuickJS 引擎的持久堆映像契约；主线程仅检查有界头部，解压及实际恢复始终留在隔离 worker。 */
export const TEMPLATE_CHECKPOINT_ENGINE = 'quickjs-emscripten@0.32.0/release-sync' as const
export const TEMPLATE_CHECKPOINT_WASM_HASH = '105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232'
export const TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES = 16 * 1024 * 1024
/** 现有 QuickJS 活跃分配上限为 512 MiB，另留 256 MiB 给 WASM 静态区、分配器和增长余量。 */
export const TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES = 768 * 1024 * 1024
export const TEMPLATE_CHECKPOINT_COMPRESSED_MAX_BYTES = 64 * 1024 * 1024
export const TEMPLATE_CHECKPOINT_PAGE_BYTES = 65536
export const TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES = TEMPLATE_CHECKPOINT_PAGE_BYTES + 256
export interface TemplateCheckpointVmHandles {
  runtime:number
  context:number
  uint32:number
  global:number
  undefined:number
  null:number
  false:number
  true:number
}
export interface TemplateCheckpointVmImage {
  version:1|2
  engine:typeof TEMPLATE_CHECKPOINT_ENGINE
  wasmHash:string
  memoryBytes:number
  memoryHash:string
  /** 每个固定 64 KiB WASM 页独立 gzip/base64；v2 用 null 表示全零页，旧 v1 仍只接受字符串。 */
  payload:Array<string|null>
  handles:TemplateCheckpointVmHandles
}

export function parseTemplateCheckpointVmImage(value:unknown):TemplateCheckpointVmImage {
  const object=(raw:unknown,keys:string[]):Record<string,unknown>=> {
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(raw,key)))throw new Error('模板检查点结构无效')
    return raw as Record<string,unknown>
  }
  const data=object(value,['version','engine','wasmHash','memoryBytes','memoryHash','payload','handles'])
  if((data.version!==1&&data.version!==2)||data.engine!==TEMPLATE_CHECKPOINT_ENGINE||data.wasmHash!==TEMPLATE_CHECKPOINT_WASM_HASH)throw new Error('模板检查点引擎版本不兼容')
  if(typeof data.memoryBytes!=='number'||!Number.isSafeInteger(data.memoryBytes)||data.memoryBytes<TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES
    ||data.memoryBytes>TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES||data.memoryBytes%65536!==0)throw new Error('模板检查点内存容量无效')
  if(typeof data.memoryHash!=='string'||!/^[0-9a-f]{64}$/.test(data.memoryHash))throw new Error('模板检查点内存摘要无效')
  if(!Array.isArray(data.payload)||data.payload.length!==data.memoryBytes/TEMPLATE_CHECKPOINT_PAGE_BYTES)throw new Error('模板检查点压缩页数量无效')
  let compressedBytes=0
  for(const page of data.payload) {
    if(page===null&&data.version===2)continue
    if(typeof page!=='string'||!page.length||page.length>4*Math.ceil(TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES/3)
      ||page.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(page))throw new Error('模板检查点压缩页无效或超限')
    const pageBytes=page.length/4*3-(page.endsWith('==') ? 2 : page.endsWith('=') ? 1 : 0)
    if(pageBytes>TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES)throw new Error('模板检查点压缩页无效或超限')
    compressedBytes+=pageBytes
    if(compressedBytes>TEMPLATE_CHECKPOINT_COMPRESSED_MAX_BYTES)throw new Error('模板检查点压缩正文超过资源容量')
  }
  const handles=object(data.handles,['runtime','context','uint32','global','undefined','null','false','true'])
  for(const pointer of Object.values(handles))if(typeof pointer!=='number'||!Number.isSafeInteger(pointer)||pointer<=0||pointer>=data.memoryBytes||pointer%4!==0)throw new Error('模板检查点句柄无效')
  return {...data,payload:[...data.payload],handles:{...handles}} as unknown as TemplateCheckpointVmImage
}
