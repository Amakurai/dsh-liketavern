/** 分块存储的规模回归：读写预算同口径、已核对的数据块不重读、任意位置插入只重写所在分页、新块一次记入楼层日志。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { Wal } from '../src/state/wal.js'
import { openLedger } from '../src/state/writeLedger.js'
import { loadTemplateState, saveTemplateState, templateTextHash, TEMPLATE_STATE_PATH, type TemplateState } from '../src/state/template.js'
import { loadTemplateDocument, prepareTemplateDocument, readTemplateDocumentText, writeTemplateBlocks, TEMPLATE_DATA_PATH } from '../src/state/templateStorage.js'
import { TEMPLATE_DISPLAY_PARTS_VERSION } from '../src/core/templateDisplay.js'

const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'tavern-template-scale-'));roots.push(root)
  const wal=new Wal(join(root,'state/wal')),fs=new WorkspaceFs(root,wal)
  return {root,wal,fs}
}
/** 等同于另一个进程接手：丢弃进程内关于磁盘内容的全部结论，下次读取重新核对。 */
const forget=(root:string)=>{openLedger(root).epoch++}
async function commit(wal:Wal,fs:WorkspaceFs,floor:string,state:TemplateState) {
  await wal.beginFloor(floor);await saveTemplateState(fs.withFloor(floor),state);await wal.commitFloor(floor)
}
function output(index:number) {
  const text=`${index}:`+'内容'.repeat(1500)
  return {hash:templateTextHash(text),text,parts:[{kind:'markdown' as const,text}],partsVersion:TEMPLATE_DISPLAY_PARTS_VERSION}
}
const story=(floors:number):TemplateState=>({version:1,variables:{global:{},local:{},message:{}},
  outputs:Object.fromEntries(Array.from({length:floors},(_,i)=>[String(i*4+5),output(i)]))})
const snapshots=(count:number)=>Object.fromEntries(Array.from({length:count},(_,i)=>[`message-${templateTextHash(String(i)).slice(0,12)}`,{values:{n:i,mood:'平静'},initialized:true}]))

it('写入通过的状态一定能读回：大量小叶子不会在落盘后才因展开预算被拒绝',async()=> {
  const {root,wal,fs}=await fixture()
  // 约 1 MiB 的数值网格：数据块很少，但展开时要访问十几万个叶子。
  const state:TemplateState={version:1,variables:{global:{grid:Array.from({length:140000},(_,i)=>100000+i%9)},local:{},message:{}},outputs:{}}
  expect(JSON.stringify(state.variables).length).toBeLessThan(1024*1024)
  await commit(wal,fs,'s#t1',state)
  expect((await fs.stat(TEMPLATE_STATE_PATH))!.size).toBeLessThan(1024)
  forget(root)
  expect(await loadTemplateState(new WorkspaceFs(root,null))).toEqual(state)
},60000)

it('合法深层宽数组的分页不占 JSON 嵌套额度，保存后丢弃缓存也能读回',async()=> {
  const {root,wal,fs}=await fixture()
  let nested:unknown=0
  for(let i=0;i<46;i++) nested=[nested,...Array<number>(1024).fill(0)]
  const state:TemplateState={version:1,variables:{global:{nested:nested as TemplateState['variables']['global'][string]},local:{},message:{}},outputs:{}}
  // 约 94 KiB、46 层数组，符合模板变量的 48 层限制；每层存储却需要多层分页索引。
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(100*1024)
  await commit(wal,fs,'s#t1',state)
  expect(await loadTemplateState(fs)).toEqual(state)
  forget(root)
  expect(await loadTemplateState(new WorkspaceFs(root,null))).toEqual(state)
},60000)

it('只取少数字段时复制选择结果，选择器和返回值都不能改写内部缓存',async()=> {
  const {fs}=await fixture(),state=story(120),path='state/projected.json'
  state.variables.global.count=7
  const document=prepareTemplateDocument(state)
  await writeTemplateBlocks(fs,document,null)
  await fs.writeText(path,document.raw)
  const parse=vi.fn((value:unknown|null)=>value as TemplateState)
  const project=(value:Readonly<TemplateState>)=>({variables:value.variables})
  const first=await loadTemplateDocument(fs,path,parse,project)
  first.variables.global.count=99
  const clone=vi.spyOn(globalThis,'structuredClone')
  const read=vi.spyOn(WorkspaceFs.prototype,'readTextMany')
  expect(await loadTemplateDocument(fs,path,parse,project)).toEqual({variables:state.variables})
  expect(parse).toHaveBeenCalledTimes(1)
  expect(read).not.toHaveBeenCalled()
  // 缓存命中时只向复制器交付选择的变量，不把整份历史回复交付后再丢弃。
  expect(clone).toHaveBeenCalledTimes(1)
  expect(clone.mock.calls[0]![0]).toEqual({variables:state.variables})
  clone.mockRestore()
  await expect(loadTemplateDocument(fs,path,parse,value=>{
    value.variables.global.count=123
    return value.variables
  })).rejects.toThrow(TypeError)
  const complete=await loadTemplateDocument(fs,path,parse)
  complete.outputs['5']!.text='修改独立副本'
  expect(await loadTemplateDocument(fs,path,parse)).toEqual(state)
  // 投影缓存仍须遵守写入登记；块被破坏后不可继续返回旧结论。
  const root=(JSON.parse(document.raw) as {root:string}).root
  await fs.writeText(`${TEMPLATE_DATA_PATH}/${root.slice(0,2)}/${root}.json`,'[]')
  await expect(loadTemplateDocument(fs,path,parse,project)).rejects.toThrow(/校验失败/)
},60000)

it('检查历史根不替换当前根，也不丢失当前投影缓存',async()=> {
  const {fs}=await fixture(),path='state/history-root.json',first=story(40),second=story(41)
  const previous=prepareTemplateDocument(first),current=prepareTemplateDocument(second)
  await writeTemplateBlocks(fs,previous,null)
  await fs.writeText(path,previous.raw)
  await writeTemplateBlocks(fs,current,previous.raw)
  await fs.writeText(path,current.raw)
  const parse=vi.fn((value:unknown|null)=>value as TemplateState)
  const project=(value:Readonly<TemplateState>)=>Object.keys(value.outputs).length
  expect(await loadTemplateDocument(fs,path,parse,project)).toBe(41)
  const references=new Set<string>()
  expect(await readTemplateDocumentText(fs,previous.raw,references)).toEqual(first)
  expect(references.size).toBeGreaterThan(0)
  expect(await fs.readText(path)).toBe(current.raw)
  const read=vi.spyOn(WorkspaceFs.prototype,'readTextMany')
  expect(await loadTemplateDocument(fs,path,parse,project)).toBe(41)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(read).not.toHaveBeenCalled()
},60000)

it('同一份状态反复读取只核对一次磁盘；保存后只探查新块，另一进程接手后重新完整核对',async()=> {
  const {root,wal,fs}=await fixture(),first=story(120)
  await commit(wal,fs,'s#t1',first)
  const blocks=(await fs.list(TEMPLATE_DATA_PATH)).length
  expect(blocks).toBeGreaterThan(300)
  const read=vi.spyOn(WorkspaceFs.prototype,'readTextMany')
  const probed=()=>{const count=read.mock.calls.reduce((total,[paths])=>total+paths.length,0);read.mockClear();return count}
  forget(root)
  expect(await loadTemplateState(fs)).toEqual(first)
  expect(probed()).toBe(blocks)
  // 根引用与数据块未变：再读不碰任何数据块，返回的仍是可独立修改的副本。
  const again=await loadTemplateState(fs)
  again.outputs['5']!.text='调用方的修改不应回到缓存'
  expect(await loadTemplateState(fs)).toEqual(first)
  expect(probed()).toBe(0)
  const second=structuredClone(first);second.outputs[String(120*4+5)]=output(120)
  await commit(wal,fs,'s#t2',second)
  const added=(await fs.list(TEMPLATE_DATA_PATH)).length-blocks
  expect(added).toBeGreaterThan(0)
  expect(added).toBeLessThan(12)
  // 保存只向磁盘确认此前未见过的块；随后读取完全来自已核对的内容。
  expect(probed()).toBe(added)
  expect(await loadTemplateState(fs)).toEqual(second)
  expect(probed()).toBe(0)
  forget(root)
  expect(await loadTemplateState(fs)).toEqual(second)
  // 重新核对的是当前根可达的全部块；被第二楼替换掉的旧分页不再读取。
  const cold=probed()
  expect(cold).toBeGreaterThan(blocks-12)
  expect(cold).toBeLessThanOrEqual(blocks+added)
},60000)

it('工作区内改写或删除数据块后不再沿用内存结论，损坏与缺失照常拒绝',async()=> {
  const {wal,fs}=await fixture(),state=story(40)
  await commit(wal,fs,'s#t1',state)
  expect(await loadTemplateState(fs)).toEqual(state)
  const manifest=JSON.parse((await fs.readText(TEMPLATE_STATE_PATH))!) as {root:string}
  const path=`${TEMPLATE_DATA_PATH}/${manifest.root.slice(0,2)}/${manifest.root}.json`,original=(await fs.readText(path))!
  await fs.writeText(path,'[]')
  await expect(loadTemplateState(fs)).rejects.toThrow(/校验失败/)
  await fs.writeText(path,original)
  expect(await loadTemplateState(fs)).toEqual(state)
  // 删掉一块新旧状态都会引用的正文叶子。
  let leaf=''
  for(const candidate of await fs.list(TEMPLATE_DATA_PATH)) {
    if((await fs.readText(`${TEMPLATE_DATA_PATH}/${candidate}`))!.startsWith('["json"')) {leaf=`${TEMPLATE_DATA_PATH}/${candidate}`;break}
  }
  expect(leaf).not.toBe('')
  await fs.delete(leaf)
  await expect(loadTemplateState(fs)).rejects.toThrow(/数据块缺失/)
  // 保存时向磁盘确认而不是凭记忆认定它还在：仍被引用的缺失块随新状态补回。
  await wal.beginFloor('s#t2')
  const changed=structuredClone(state);changed.variables.message.touched=true
  await saveTemplateState(fs.withFloor('s#t2'),changed)
  expect(await fs.exists(leaf)).toBe(true)
  expect(await loadTemplateState(fs)).toEqual(changed)
},60000)

it('按身份排序的大表在任意位置插入新键只重写所在分页，不让其后的分页整体错位',async()=> {
  const {wal,fs}=await fixture()
  const first:TemplateState={version:1,variables:{global:{},local:{},message:{}},outputs:{},messageVariables:{version:1,snapshots:snapshots(3000)}}
  await commit(wal,fs,'s#t1',first)
  const before=new Set(await fs.list(TEMPLATE_DATA_PATH))
  expect(before.size).toBeGreaterThan(100)
  const second=structuredClone(first)
  // 排序后落在表的最前、中间与靠后的位置。
  for(const id of ['message-0000aaaa0000','message-7fffaaaa0000','message-efffaaaa0000']) second.messageVariables!.snapshots[id]={values:{n:-1,mood:'新增'},initialized:true}
  await commit(wal,fs,'s#t2',second)
  const added=(await fs.list(TEMPLATE_DATA_PATH)).filter(path=>!before.has(path))
  // 三处插入各自的分页、少量上层索引与根；按位置切分时最前面的插入会重写全部一百多页。
  expect(added.length).toBeLessThan(24)
  expect(await loadTemplateState(fs)).toEqual(await loadTemplateState(new WorkspaceFs(fs.root,null)))
  expect(Object.keys((await loadTemplateState(fs)).messageVariables!.snapshots)).toHaveLength(3003)
},60000)

it('一次保存的全部新块合并为一次日志追加，根记录排在所有新块之后',async()=> {
  const {root,wal,fs}=await fixture(),state=story(60)
  await wal.beginFloor('s#t1')
  const append=vi.spyOn(wal,'recordChanges')
  await saveTemplateState(fs.withFloor('s#t1'),state)
  // 新块一批，根引用一条。
  expect(append).toHaveBeenCalledTimes(2)
  const lines=(await fs.readText('state/wal/s_t1/records.jsonl'))!.trim().split('\n').map(line=>JSON.parse(line) as {seq:number;path:string;before:string|null})
  expect(lines.map(line=>line.seq)).toEqual(lines.map((_,index)=>index+1))
  expect(lines.at(-1)!.path).toBe(TEMPLATE_STATE_PATH)
  expect(lines.slice(0,-1).every(line=>line.path.startsWith(TEMPLATE_DATA_PATH+'/') && line.before===null)).toBe(true)
  expect(lines.length-1).toBe((await fs.list(TEMPLATE_DATA_PATH)).length)
  await wal.commitFloor('s#t1')
  await wal.rollbackFloor('s#t1',root)
  expect(await fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  expect(await fs.list(TEMPLATE_DATA_PATH)).toEqual([])
},60000)
