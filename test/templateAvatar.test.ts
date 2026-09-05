/** 头像兼容的安全资产与轮初冻结测试：剥离卡片元数据，固定路径读取，缺失和超量有明确空值。 */
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it } from 'vitest'
import { isTemplateAvatarUrl,templateAvatarPng,TEMPLATE_AVATAR_BYTES } from '../src/core/templateAvatar.js'
import { embedCardInPng,parseJsonCard } from '../src/state/card.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { loadTemplateAvatars } from '../src/node/templateAvatar.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { loadTemplateState } from '../src/state/template.js'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
const png=()=>embedCardInPng(null,{name:'DO-NOT-EXPOSE-PNG-METADATA',privateBlob:'x'.repeat(10000)},'chara_card_v2')
async function setup() {
  const root=await mkdtemp(join(tmpdir(),'tavern-template-avatar-'));roots.push(root)
  const state=new TavernState({root,characters:join(root,'characters'),personas:join(root,'personas'),lorebooks:join(root,'library/lorebooks'),
    presets:join(root,'library/presets'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))
  await state.init()
  const card=parseJsonCard({name:'头像',description:'<%- charAvatar.length > 0 %>:<%- userAvatar %>'})
  const imported=await state.importCharacter('avatar.json',Buffer.from(JSON.stringify(card.raw)))
  const fs=(await state.workspace(imported.cardId)).fs
  return {state,cardId:imported.cardId,fs}
}

describe('模板头像',()=> {
  it('只保留 PNG 图像块，清除嵌入角色元数据与尾随字节',()=> {
    const source=Buffer.concat([png(),Buffer.from('trailing secret')])
    const output=templateAvatarPng(source)!
    expect(output.length).toBeLessThan(100)
    expect(Buffer.from(output).includes(Buffer.from('DO-NOT-EXPOSE'))).toBe(false)
    expect(Buffer.from(output).includes(Buffer.from('trailing'))).toBe(false)
    expect(templateAvatarPng(output)).toEqual(output)
  })
  it('拒绝非法签名、截断、超量图像块及非 PNG 地址',()=> {
    expect(templateAvatarPng(Buffer.from('<svg onload="alert(1)">'))).toBeNull()
    expect(templateAvatarPng(png().slice(0,-4))).toBeNull()
    const bare=templateAvatarPng(png())!
    const chunk=Buffer.alloc(TEMPLATE_AVATAR_BYTES+12)
    chunk.writeUInt32BE(TEMPLATE_AVATAR_BYTES);chunk.write('IDAT',4)
    expect(templateAvatarPng(Buffer.concat([bare.slice(0,33),chunk,bare.slice(33)]))).toBeNull()
    for(const value of ['https://secret.example/avatar','javascript:alert(1)','data:image/svg+xml;base64,AAAA',{},'data:image/png;base64,***']) expect(isTemplateAvatarUrl(value)).toBe(false)
    expect(isTemplateAvatarUrl('')).toBe(true)
    expect(isTemplateAvatarUrl(`data:image/png;base64,${Buffer.from(bare).toString('base64')}`)).toBe(true)
  })
  it('从当前卡和当前人设固定文件读取，不读取头像字段指定的其他文件',async()=> {
    const {state,cardId,fs}=await setup()
    expect(await loadTemplateAvatars(state,cardId,null)).toEqual({charAvatar:'',userAvatar:''})
    await fs.writeBytes('card.png',png())
    const personas=new WorkspaceFs(state.paths.personas,null)
    await personas.writeBytes('current.png',png())
    const persona={id:'current',name:'本人',description:'',avatar:'current.png'}
    const found=await loadTemplateAvatars(state,cardId,persona)
    expect(found.charAvatar).toMatch(/^data:image\/png;base64,/)
    expect(found.userAvatar).toBe(found.charAvatar)
    for(const avatar of ['../characters/card.png','other.png','https://example.com/avatar.png',null]) {
      expect((await loadTemplateAvatars(state,cardId,{...persona,avatar})).userAvatar).toBe('')
    }
    expect((await loadTemplateAvatars(state,cardId,{...persona,id:'../current',avatar:'../current.png'})).userAvatar).toBe('')
  })
  it('头像与生成计划一起冻结，文件变更下一轮生效，重放描述保持原快照',async()=> {
    const {state,cardId,fs}=await setup()
    await fs.writeBytes('card.png',png())
    await saveBinding(state.paths,{sessionId:'s1',cardId,cardName:'头像',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,
      interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
    await onTurnStart(state,'s1',1)
    const run=()=>runTavernPipeline({state,sessionId:'s1',mode:'live',agent:null,historyOverride:[]})
    const first=(await run())!
    expect(first.templateContext!.charAvatar).toMatch(/^data:image\/png;base64,/)
    expect(first.turnContext).toContain('true:')
    await fs.delete('card.png')
    expect(await run()).toBe(first)
    const binding=(await state.loadBinding('s1'))!
    const stored=await loadTemplateState((await state.storyWorkspace(cardId,binding.storyId)).fs)
    expect(stored.generation?.status==='prepared' && stored.generation.replay.context.charAvatar).toBe(first.templateContext!.charAvatar)
    const preview=(await runTavernPipeline({state,sessionId:'s1',mode:'preview',agent:null,historyOverride:[]}))!
    expect(preview.templateContext!.charAvatar).toBe('')
    expect(preview.turnContext).toContain('false:')
  })
})
