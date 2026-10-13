/** 大型模板状态集成：无损复用、低增量 WAL、提交中断、旧存档迁移、分支和损坏拒绝。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { Wal } from '../src/state/wal.js'
import { loadTemplateState, saveTemplateState, saveTemplateTimers, templateTextHash, TEMPLATE_STATE_PATH, type TemplateState } from '../src/state/template.js'
import { TEMPLATE_DATA_PATH } from '../src/state/templateStorage.js'
import { newStoryId, snapshotStory, storyRoot } from '../src/state/story.js'
import { TEMPLATE_DISPLAY_PARTS_VERSION } from '../src/core/templateDisplay.js'
import { mergeTemplateMessageVariables, parseTemplateMessageVariables, visibleTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'

const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'tavern-template-storage-'));roots.push(root)
  const wal=new Wal(join(root,'state/wal')),fs=new WorkspaceFs(root,wal)
  return {root,wal,fs}
}
function output(index:number) {
  const text=`${index}:`+'内容'.repeat(15000)
  return {hash:templateTextHash(text),text,parts:[{kind:'markdown' as const,text}],partsVersion:TEMPLATE_DISPLAY_PARTS_VERSION}
}
function largeState():TemplateState {
  return {version:1,variables:{global:{},local:{},message:{}},outputs:Object.fromEntries(Array.from({length:32},(_,i)=>[String(i),output(i)]))}
}

it('超过旧总上限的历史无损恢复，新楼只增加新内容，分支与 WAL 回退保持完整',async()=> {
  const {root,wal,fs}=await fixture(),first=largeState()
  expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(4*1024*1024)
  await wal.beginFloor('s1#t1');await saveTemplateState(fs.withFloor('s1#t1'),first);await wal.commitFloor('s1#t1')
  expect(await loadTemplateState(new WorkspaceFs(root,wal))).toEqual(first)
  expect((await fs.stat(TEMPLATE_STATE_PATH))!.size).toBeLessThan(1024)
  const second=structuredClone(first);second.outputs['32']=output(32)
  await wal.beginFloor('s1#t2');await saveTemplateState(fs.withFloor('s1#t2'),second);await wal.commitFloor('s1#t2')
  expect((await fs.stat('state/wal/s1_t2/records.jsonl'))!.size).toBeLessThan(Buffer.byteLength(JSON.stringify(second))/4)
  const id=newStoryId()
  await snapshotStory({cardRoot:root,sourceRoot:root,id,sessionId:'child',includeWal:true,prepare:async draft=>{
    await new Wal(join(draft.root,'state/wal')).rollbackAfter(['s1#t2'],draft.root)
  }})
  expect(await loadTemplateState(new WorkspaceFs(storyRoot(root,id),null))).toEqual(first)
  expect(await loadTemplateState(fs)).toEqual(second)
  await wal.rollbackFloor('s1#t2',root)
  expect(await loadTemplateState(fs)).toEqual(first)
},30000)

it('根提交前中断保留旧快照，重试不重复新块，随后能撤销整个失败楼层',async()=> {
  const {root,wal,fs}=await fixture(),first=largeState()
  await wal.beginFloor('s1#t1');await saveTemplateState(fs.withFloor('s1#t1'),first);await wal.commitFloor('s1#t1')
  const before=await fs.readText(TEMPLATE_STATE_PATH),second=structuredClone(first);second.outputs['32']=output(32)
  await wal.beginFloor('s1#t2')
  const write=WorkspaceFs.prototype.writeText
  const fault=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){
    if(path===TEMPLATE_STATE_PATH)throw new Error('工厂根提交中断')
    return write.call(this,path,text)
  })
  await expect(saveTemplateState(fs.withFloor('s1#t2'),second)).rejects.toThrow('工厂根提交中断')
  expect(await fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
  expect(await loadTemplateState(fs)).toEqual(first)
  const blocks=await fs.list(TEMPLATE_DATA_PATH)
  fault.mockRestore()
  await saveTemplateState(fs.withFloor('s1#t2'),second)
  expect(await fs.list(TEMPLATE_DATA_PATH)).toEqual(blocks)
  expect(await loadTemplateState(fs)).toEqual(second)
  await wal.rollbackFloor('s1#t2',root)
  expect(await loadTemplateState(fs)).toEqual(first)
},30000)

it('本地抬高上限留下的旧 JSON 可读并无损迁移，缺失或被篡改的数据块拒绝读取',async()=> {
  const {wal,fs}=await fixture(),expected=largeState()
  await fs.writeText(TEMPLATE_STATE_PATH,JSON.stringify(expected))
  expect(await loadTemplateState(fs)).toEqual(expected)
  await wal.beginFloor('s1#t1');await saveTemplateState(fs.withFloor('s1#t1'),expected)
  const manifest=JSON.parse((await fs.readText(TEMPLATE_STATE_PATH))!) as {root:string}
  const path=`${TEMPLATE_DATA_PATH}/${manifest.root.slice(0,2)}/${manifest.root}.json`
  const original=(await fs.readText(path))!
  await fs.writeText(path,'[]')
  await expect(loadTemplateState(fs)).rejects.toThrow(/校验失败/)
  await fs.writeText(path,original);await fs.delete(path)
  await expect(loadTemplateState(fs)).rejects.toThrow(/数据块缺失/)
},30000)

it('长历史消息变量按稳定身份筛选，超过旧可见条数预算的合法集合仍可读，内部块与清单不向资产工具开放',()=> {
  const previous={version:1 as const,snapshots:Object.fromEntries(Array.from({length:4096},(_,i)=>['old-'+i,{values:{n:i},initialized:true}]))}
  const next={version:1 as const,snapshots:{current:{values:{n:4096},initialized:true}}},identities=[{messageId:'current',swipeId:0 as const}]
  const merged=mergeTemplateMessageVariables(previous,next,identities)
  expect(Object.keys(merged.snapshots)).toHaveLength(4097)
  expect(parseTemplateMessageVariables(visibleTemplateMessageVariables(merged,identities))).toEqual(next)
  expect(parseTemplateMessageVariables(merged)).toEqual(merged)
  for(const path of ['state/template-data/ab/file.json','STATE/./TEMPLATE-DATA/ab/file.json','state/wal-coverage.json'])expect(resolveReadableAssetPath(path).ok).toBe(false)
})

it('楼层外维护保留了新根时，回滚不能删除它复用的旧块',async()=> {
  const {root,wal,fs}=await fixture(),first=largeState()
  first.wiTimers={s1:{stickyLeft:{},cooldownLeft:{a:1}}}
  await wal.beginFloor('s1#t1');await saveTemplateState(fs.withFloor('s1#t1'),first);await wal.commitFloor('s1#t1')
  const timers={stickyLeft:{},cooldownLeft:{a:9}}
  await saveTemplateTimers(fs,'s1',timers)
  await wal.rollbackFloor('s1#t1',root)
  expect(await loadTemplateState(fs)).toEqual({...first,wiTimers:{s1:timers}})
},30000)
