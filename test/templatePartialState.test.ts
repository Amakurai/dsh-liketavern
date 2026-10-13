/** 冷启动按业务字段读取模板状态：独立回复不依赖其它正文块，完整恢复和写入仍校验全部历史。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { Wal } from '../src/state/wal.js'
import { openLedger } from '../src/state/writeLedger.js'
import { loadTemplateGenerationIdentity, loadTemplateMetadata, loadTemplateOutputs, loadTemplateState, loadTemplateTimers,
  saveTemplateMetadata, saveTemplateState, templateTextHash, type TemplateState } from '../src/state/template.js'
import { prepareTemplateDocument, TEMPLATE_DATA_PATH } from '../src/state/templateStorage.js'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'tavern-partial-state-'));roots.push(root)
  const wal=new Wal(join(root,'state/wal')),fs=new WorkspaceFs(root,wal)
  const state:TemplateState={version:1,variables:{global:{count:7},local:{},message:{}},
    generation:{version:1,status:'completed',sessionId:'s',cardId:'card',storyId:'story-12345678-1234-1234-1234-123456789abc',turn:1,floor:'s#t1'},
    wiTimers:{s:{stickyLeft:{entry:2},cooldownLeft:{}}},
    outputs:Object.fromEntries(Array.from({length:120},(_,index)=>{
      const text=`旧正文-${index}:`+'内容'.repeat(3000)
      return [String(index),{hash:templateTextHash(text),text}]
    }))}
  await wal.beginFloor('s#t1');await saveTemplateState(fs.withFloor('s#t1'),state);await wal.commitFloor('s#t1')
  return {root,fs,wal,state}
}

it('冷读归属、定时器、元数据和单条回复不访问其它回复正文，写入仍拒绝坏历史',async()=> {
  const {root,fs,wal,state}=await fixture()
  const document=prepareTemplateDocument(state)
  const bad=[...document.blocks].find(([,text])=>text.includes('旧正文-40:'))?.[0]
  expect(bad).toBeDefined()
  await fs.withFloor(null).writeText(`${TEMPLATE_DATA_PATH}/${bad!.slice(0,2)}/${bad}.json`,'["json","坏正文"]')
  const cold=()=>{openLedger(root).epoch++;return new WorkspaceFs(root,wal)}
  expect(await loadTemplateGenerationIdentity(cold())).toEqual(state.generation)
  expect(await loadTemplateTimers(cold(),'s')).toEqual(state.wiTimers!.s)
  const {outputs:_outputs,...expected}=state
  expect(await loadTemplateMetadata(cold())).toEqual(expected)
  const picked=await loadTemplateOutputs(cold(),[119,119,999])
  expect(picked).toEqual({'119':state.outputs['119']})
  picked['119']!.text='调用方修改'
  expect((await loadTemplateOutputs(cold(),[119]))['119']!.text).toBe(state.outputs['119']!.text)
  await expect(loadTemplateOutputs(cold(),[40])).rejects.toThrow(/校验失败/)
  await expect(loadTemplateState(cold())).rejects.toThrow(/校验失败/)
  await wal.beginFloor('s#t2')
  await expect(saveTemplateMetadata(cold().withFloor('s#t2'),expected)).rejects.toThrow(/校验失败/)
},30000)

it('旧内联状态同样选择消息，新增坏定时器不能回退旧文件',async()=> {
  const {fs,state}=await fixture()
  await fs.withFloor(null).writeText('state/template.json',JSON.stringify(state))
  expect(await loadTemplateOutputs(fs,[3,12])).toEqual({'3':state.outputs['3'],'12':state.outputs['12']})
  await expect(loadTemplateOutputs(fs,[-1])).rejects.toThrow(/身份无效/)
  await fs.withFloor(null).writeText('state/wi-timers/s.json',JSON.stringify({stickyLeft:{old:4},cooldownLeft:{}}))
  await fs.withFloor(null).writeText('state/template.json',JSON.stringify({...state,wiTimers:null}))
  await expect(loadTemplateTimers(fs,'s')).rejects.toThrow(/定时状态损坏/)
})
