/** 固定 WASM 的 dlmalloc 空闲区识别；验证后仅给快照分页副本提供清零区间与末尾 top 裁剪补丁，不改实时堆、不触发 GC。 */
import {TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES,TEMPLATE_CHECKPOINT_PAGE_BYTES} from '../core/templateCheckpoint.js'

export interface TemplateCheckpointMemory {
  segmentEnd:number
  /** 最后活块之后只保留至少一个分配器页；所有 live 地址保持不变。 */
  memoryBytes:number
  /** 按地址排序的 little-endian u32；分页副本先清零，再应用这些分配器元数据补丁。 */
  patches:ReadonlyArray<readonly [offset:number,value:number]>
  freeBytes:number
  freeChunks:number
  zeroRanges:()=>Generator<readonly [number,number]>
}

// Emscripten 5.0.1 / dlmalloc，须与调用方已核对的固定 WASM SHA 一起使用。
const HEAP_BASE=5333088
const SBRK=86864
const STATE=88260
const SEGMENT=88708
const TRIM_THRESHOLD=88748
const TOP_FOOT_BYTES=40
const ALLOCATOR_PAGE_BYTES=4096

/** 对应 dlmalloc internal_inspect_all：小空闲块保留 fd/bk，大块再保留 child/parent/index。 */
const freeHeader=(size:number)=>size<256?16:32

export function templateCheckpointMemory(bytes:Uint8Array):TemplateCheckpointMemory|undefined {
  // 未知布局仍可原样快照；不能猜测元数据边界后清除潜在活对象。
  if(bytes.length<HEAP_BASE+TOP_FOOT_BYTES||bytes.length%65536!==0)return undefined
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),word=(offset:number)=>view.getUint32(offset,true)
  const base=word(SEGMENT),size=word(SEGMENT+4),segmentEnd=base+size,top=word(STATE+24),topSize=word(STATE+12)
  if(base!==HEAP_BASE||word(STATE+16)!==base||word(SEGMENT+8)!==0||word(SEGMENT+12)!==0
    ||word(SBRK)!==segmentEnd||word(STATE+432)!==size||segmentEnd>bytes.length||segmentEnd%8!==0
    ||top<base||top%8!==0||topSize<8||topSize%8!==0||top+topSize+TOP_FOOT_BYTES!==segmentEnd
    ||word(top+4)!==(topSize|1)||word(top+topSize+4)!==TOP_FOOT_BYTES)return undefined
  const dv=word(STATE+20),dvSize=word(STATE+8)
  let at=base,previousInUse=true,dvSeen=dv===0&&dvSize===0,freeBytes=0,freeChunks=0
  while(at<top) {
    const head=word(at+4),chunkSize=head&~7,next=at+chunkSize,inUse=Boolean(head&2)
    if(chunkSize<16||chunkSize%8!==0||next>top||(head&4)!==0||(head&3)===0
      ||Boolean(head&1)!==previousInUse||Boolean(word(next+4)&1)!==inUse)return undefined
    if(!inUse) {
      if(word(next)!==chunkSize)return undefined
      if(at===dv) {if(chunkSize!==dvSize)return undefined;dvSeen=true}
      freeBytes+=Math.max(0,chunkSize-freeHeader(chunkSize));freeChunks++
    }
    previousInUse=inUse;at=next
  }
  if(at!==top||!dvSeen)return undefined
  freeBytes+=Math.max(0,topSize-freeHeader(topSize))
  const pageEnd=(end:number)=>Math.max(TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES,Math.ceil(end/TEMPLATE_CHECKPOINT_PAGE_BYTES)*TEMPLATE_CHECKPOINT_PAGE_BYTES)
  // 固定构建 HAVE_MMAP=0，单一 sbrk 段；末尾 top 是未分配区，恢复后可正常再次增长。
  // 对齐与 max_footprint 不符的未知旧布局仍可清空已验证 free payload，但不改其分配器边界。
  const canTrim=segmentEnd%ALLOCATOR_PAGE_BYTES===0&&word(STATE+436)>=size
  const memoryBytes=Math.min(bytes.length,pageEnd(segmentEnd),canTrim?pageEnd(top+ALLOCATOR_PAGE_BYTES+TOP_FOOT_BYTES):bytes.length)
  const patches:Array<readonly [number,number]>=[]
  if(memoryBytes<segmentEnd) {
    const released=segmentEnd-memoryBytes,newTopSize=topSize-released
    // 对应 dlmalloc sys_trim + init_top：保留 top.prev_foot（可能是前一 live 块的尾字）、
    // max_footprint、bins、DV 与所有对象地址；只重置 sbrk、段大小、当前 footprint 与 top 尾标记。
    patches.push([SBRK,memoryBytes],[SEGMENT+4,size-released],[STATE+432,size-released],
      [STATE+12,newTopSize],[top+4,newTopSize|1],[top+newTopSize+4,TOP_FOOT_BYTES],[STATE+28,word(TRIM_THRESHOLD)])
    patches.sort((left,right)=>left[0]-right[0])
  }
  return {segmentEnd,memoryBytes,patches,freeBytes,freeChunks,zeroRanges:function*() {
    // 调用方在此迭代完成之前不会再进入 VM，二次扫描无需保存数量随堆增长的区间数组。
    for(let pointer=base;pointer<top;) {
      const head=word(pointer+4),chunkSize=head&~7,next=pointer+chunkSize
      if(!(head&2)&&chunkSize>freeHeader(chunkSize))yield [pointer+freeHeader(chunkSize),next] as const
      pointer=next
    }
    if(topSize>freeHeader(topSize))yield [top+freeHeader(topSize),top+topSize] as const
    if(segmentEnd<bytes.length)yield [segmentEnd,bytes.length] as const
  }}
}
