/** 冷启动路径读取只核对所需模板子图；不读无关正文，局部缓存不冒充完整校验，旧文件与损坏边界保持明确。 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { openLedger } from '../src/state/writeLedger.js'
import { loadTemplateDocumentPaths, prepareTemplateDocument, readTemplateDocument, readTemplateDocumentPaths, TEMPLATE_DATA_PATH, writeTemplateBlocks } from '../src/state/templateStorage.js'

const roots:string[]=[],path='state/selection.json'
/** 600 楼夹具需实际刷盘数千个块；CI 磁盘耗时不属于被测读取预算，读取效率仍由访问块数断言。 */
const largeFixtureTimeout=60_000
afterEach(async()=> {vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture(value:unknown) {
  const root=await mkdtemp(join(tmpdir(),'tavern-template-selection-'));roots.push(root)
  const fs=new WorkspaceFs(root,null),document=prepareTemplateDocument(value)
  await writeTemplateBlocks(fs,document,null);await fs.writeText(path,document.raw)
  openLedger(root).epoch++
  return {fs,document,root}
}
const blockPath=(hash:string)=>`${TEMPLATE_DATA_PATH}/${hash.slice(0,2)}/${hash}.json`
const history=(floors:number)=>({version:1,variables:{global:{day:3},local:{},message:{}},
  generation:{status:'prepared',turn:237,plan:{messages:['冻结计划正文'.repeat(10000)]}},
  outputs:Object.fromEntries(Array.from({length:floors},(_,i)=>[String(i),{hash:`hash-${i}`,text:`reply-${i}:`+'正文'.repeat(3000)}])),
  messageVariables:{version:1,snapshots:Object.fromEntries(Array.from({length:floors},(_,i)=>[`message-${i}`,{values:{mood:`snapshot-${i}:`+'记忆'.repeat(2000)}}]))}})

it('冷读身份和变量不展开历史回复、消息变量或生成计划，暖读只返回独立的选择副本',async()=> {
  const value=history(600),{fs,document,root}=await fixture(value)
  expect(document.blocks.size).toBeGreaterThan(1200)
  const read=vi.spyOn(WorkspaceFs.prototype,'readTextMany')
  const paths=[['version'],['generation','status'],['generation','turn'],['variables']] as const
  const selected=await readTemplateDocumentPaths(new WorkspaceFs(root,null),path,paths)
  expect(selected).toEqual([1,'prepared',237,value.variables])
  const accessed=read.mock.calls.flatMap(([items])=>items)
  // 根与 generation 小索引足够；两个 600 楼历史表及计划正文均没有读取。
  expect(accessed.length).toBeLessThanOrEqual(3)
  expect(accessed.every(item=>!document.blocks.get(item.split('/').at(-1)!.slice(0,-5))!.startsWith('["json"'))).toBe(true)
  ;(selected![3] as typeof value.variables).global.day=99
  read.mockClear()
  expect(await readTemplateDocumentPaths(fs,path,paths)).toEqual([1,'prepared',237,value.variables])
  expect(read).not.toHaveBeenCalled()
},largeFixtureTimeout)

it('按消息键选择仅扫描键页，未选中的坏正文不影响局部读取，但完整读取仍拒绝',async()=> {
  const value=history(600),{fs,document}=await fixture(value)
  const damaged=[...document.blocks].find(([,raw])=>raw.startsWith('["json"') && raw.includes('reply-123:'))![0]
  await fs.writeText(blockPath(damaged),'[]')
  const read=vi.spyOn(WorkspaceFs.prototype,'readTextMany')
  expect(await readTemplateDocumentPaths(fs,path,[['outputs','456'],['outputs','599'],['outputs','missing']])).toEqual([value.outputs['456'],value.outputs['599'],undefined])
  const accessed=read.mock.calls.flatMap(([items])=>items)
  expect(accessed).not.toContain(blockPath(damaged))
  expect(accessed.length).toBeLessThan(80)
  expect(accessed.length).toBeLessThan(document.blocks.size/10)
  await expect(readTemplateDocument(fs,path)).rejects.toThrow(/校验失败/)
  await expect(readTemplateDocumentPaths(fs,path,[['outputs','123']])).rejects.toThrow(/校验失败/)
},largeFixtureTimeout)

it('连续打开不同消息复用已核对的键页，只读取新消息的快照索引与正文',async()=> {
  const value=history(600),{fs,document}=await fixture(value)
  const read=vi.spyOn(WorkspaceFs.prototype,'readTextMany')
  expect(await readTemplateDocumentPaths(fs,path,[['outputs','456'],['outputs','599']])).toEqual([value.outputs['456'],value.outputs['599']])
  const initial=new Set(read.mock.calls.flatMap(([items])=>items))
  expect(initial.size).toBeGreaterThan(20)
  read.mockClear()
  expect(await readTemplateDocumentPaths(fs,path,[['outputs','123']])).toEqual([value.outputs['123']])
  const next=read.mock.calls.flatMap(([items])=>items)
  // 旧格式中每条快照另有一个 object 小块及正文 json 块；整张回复表的键页不会再读。
  expect(next).toHaveLength(2)
  expect(next.every(item=>!initial.has(item))).toBe(true)
  const values=next.map(item=>JSON.parse(document.blocks.get(item.split('/').at(-1)!.slice(0,-5))!) as unknown[])
  expect(values.map(item=>item[0]).sort()).toEqual(['json','object'])
  read.mockClear()
  expect(await readTemplateDocumentPaths(fs,path,[['outputs','124']])).toEqual([value.outputs['124']])
  expect(read.mock.calls.flatMap(([items])=>items)).toHaveLength(2)
},largeFixtureTimeout)

it('被选中的正文或根块改写后丢弃暖缓存，不把旧选择结果当作成功',async()=> {
  const value=history(40),{fs,document}=await fixture(value)
  expect(await readTemplateDocumentPaths(fs,path,[['outputs','5']])).toEqual([value.outputs['5']])
  const leaf=[...document.blocks].find(([,raw])=>raw.startsWith('["json"') && raw.includes('reply-5:'))![0]
  await fs.delete(blockPath(leaf))
  await expect(readTemplateDocumentPaths(fs,path,[['outputs','5']])).rejects.toThrow(/数据块缺失/)
  const root=(JSON.parse(document.raw) as {root:string}).root
  await fs.writeText(blockPath(root),'[]')
  await expect(readTemplateDocumentPaths(fs,path,[['version']])).rejects.toThrow(/校验失败/)
})

it('业务解析器仅在冷读或根与数据块改变后执行，选择解析结果不能污染完整图结论',async()=> {
  const value=history(40),{fs,document}=await fixture(value),paths=[['variables']] as const
  const parse=vi.fn((values:Array<unknown|undefined>|null)=>({variables:values![0] as typeof value.variables}))
  const first=await loadTemplateDocumentPaths(fs,path,paths,parse)
  first.variables.global.day=99
  const read=vi.spyOn(WorkspaceFs.prototype,'readTextMany')
  expect(await loadTemplateDocumentPaths(fs,path,paths,parse)).toEqual({variables:value.variables})
  expect(parse).toHaveBeenCalledTimes(1)
  expect(read).not.toHaveBeenCalled()
  const leaf=[...document.blocks].find(([,raw])=>raw.startsWith('["json"') && raw.includes('reply-5:'))![0]
  await fs.delete(blockPath(leaf))
  expect(await loadTemplateDocumentPaths(fs,path,paths,parse)).toEqual({variables:value.variables})
  expect(parse).toHaveBeenCalledTimes(2)
  await expect(readTemplateDocument(fs,path)).rejects.toThrow(/数据块缺失/)
  const changed=prepareTemplateDocument({...value,variables:{...value.variables,global:{day:4}}})
  await writeTemplateBlocks(fs,changed,document.raw);await fs.writeText(path,changed.raw)
  expect((await loadTemplateDocumentPaths(fs,path,paths,parse)).variables.global.day).toBe(4)
  expect(parse).toHaveBeenCalledTimes(3)
})

it('旧内联文件、数组分页与缺失属性按路径读取，返回值不能修改下一次读取',async()=> {
  const {fs}=await fixture({version:1,items:[{name:'一'}],outputs:{}})
  expect(await readTemplateDocumentPaths(fs,path,[['items',0,'name'],['items',1],['outputs','missing']])).toEqual(['一',undefined,undefined])
  expect(await readTemplateDocumentPaths(fs,'state/missing.json',[['version']])).toBeNull()
  const value={version:1,rows:Array.from({length:2100},(_,i)=>({index:i,text:`${i}:`+'长内容'.repeat(100)}))}
  const document=prepareTemplateDocument(value)
  await writeTemplateBlocks(fs,document,await fs.readText(path));await fs.writeText(path,document.raw)
  expect(await readTemplateDocumentPaths(fs,path,[['rows',2033],['rows',9000]])).toEqual([value.rows[2033],undefined])
  expect(await readTemplateDocumentPaths(fs,path,[[]])).toEqual([value])
},30000)

it.each([null,[],7,'text'])('路径父字段为 %j 时拒绝而不是冒充缺少消息',async outputs=> {
  const {fs}=await fixture({version:1,outputs,unrelated:'大状态'.repeat(30000)})
  await expect(readTemplateDocumentPaths(fs,path,[['outputs','5']])).rejects.toThrow(/容器类型/)
})

it('摘要正确但遍历的对象键页有重复键时也拒绝，根的未知字段不能绕过验证',async()=> {
  const {fs}=await fixture({version:1})
  const raw=JSON.stringify(['object',[['version',{json:'1'}],['version',{json:'2'}]]])
  const hash=createHash('sha256').update(raw).digest('hex')
  await fs.writeText(blockPath(hash),raw)
  const manifest={version:2,storage:'tavern-template',root:hash,bytes:65537}
  await fs.writeText(path,JSON.stringify(manifest))
  await expect(readTemplateDocumentPaths(fs,path,[['version']])).rejects.toThrow(/键重复/)
  await fs.writeText(path,JSON.stringify({...manifest,extra:true}))
  await expect(readTemplateDocumentPaths(fs,path,[['version']])).rejects.toThrow(/根引用损坏/)
})

it('内联 JSON 块中的选择结果也受根声明的展开体积约束',async()=> {
  const {fs}=await fixture({version:1})
  const raw=JSON.stringify(['json',JSON.stringify({version:1})]),hash=createHash('sha256').update(raw).digest('hex')
  await fs.writeText(blockPath(hash),raw)
  await fs.writeText(path,JSON.stringify({version:2,storage:'tavern-template',root:hash,bytes:0}))
  await expect(readTemplateDocumentPaths(fs,path,[['version']])).rejects.toThrow(/字节数不一致/)
})

it('穿过不同字段的分页深度累计检查，不能每次下钻重新得到一份引用预算',async()=> {
  const {fs}=await fixture({version:1}),blocks:Array<[string,string]>=[]
  const block=(value:unknown)=> {
    const raw=JSON.stringify(value),hash=createHash('sha256').update(raw).digest('hex')
    blocks.push([blockPath(hash),raw]);return {ref:hash}
  }
  let child=block(['object',[['value',{json:'1'}]]])
  for(let i=0;i<300;i++)child=block(['object-pages',[child]])
  let root=block(['object',[['nested',child]]])
  for(let i=0;i<300;i++)root=block(['object-pages',[root]])
  await fs.writeTextMany(blocks)
  await fs.writeText(path,JSON.stringify({version:2,storage:'tavern-template',root:root.ref,bytes:22}))
  await expect(readTemplateDocumentPaths(fs,path,[['nested','value']])).rejects.toThrow(/展开超过上限/)
  await expect(readTemplateDocumentPaths(fs,path,[['nested']])).rejects.toThrow(/展开超过上限/)
},30000)

it('遍历的大键页本身已超过根的字节声明时，不能靠选择一个小值绕过预算',async()=> {
  const {fs}=await fixture({version:1})
  const raw=JSON.stringify(['object',[['x'.repeat(100000),{json:'1'}],['wanted',{json:'1'}]]])
  const hash=createHash('sha256').update(raw).digest('hex')
  await fs.writeText(blockPath(hash),raw)
  await fs.writeText(path,JSON.stringify({version:2,storage:'tavern-template',root:hash,bytes:1}))
  await expect(readTemplateDocumentPaths(fs,path,[['wanted']])).rejects.toThrow(/字节数不一致/)
})
