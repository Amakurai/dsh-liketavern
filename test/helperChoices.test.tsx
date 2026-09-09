/** 文本选项边界：验证剧情隔离、预算、草稿保护和宿主只填草稿而不发消息。 */
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import type {ReactNode} from 'react'
import {expect,it,vi} from 'vitest'
import type {SessionInput} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {ScriptChoices,parseScriptChoices,choiceDraft,publishScriptChoices,clearScriptChoices,installChoiceInput} from '../src/client/helperChoices.js'
import type {HelperSnapshot} from '../src/core/helperRuntime.js'
import {Btn} from '../src/client/util.js'
vi.mock('@deepseek-ai/dsh-client-ui-primitives',()=>({Button:(p:{children?:ReactNode})=><button>{p.children}</button>,Tooltip:(p:{children?:ReactNode})=><>{p.children}</>,IconChevronDownOutline14:()=>null}))
const context:HelperSnapshot={storyId:'story',historyRevision:'rev',currentMessageId:0,messages:[{message_id:0,name:'Character',role:'assistant',message:'sample',is_hidden:false,data:{},extra:{}}],scopes:{},writable:true}
it('有界纯文本选项拒绝额外字段与不可见目标',()=>{
  expect(()=>parseScriptChoices([{label:'x',text:'y',html:'<script>'}])).toThrow()
  expect(()=>parseScriptChoices(Array.from({length:33},()=>({label:'x',text:'y'})))).toThrow()
  expect(()=>publishScriptChoices(Symbol(),'s',context,1,[])).toThrow()
  expect(choiceDraft('my draft','first','')).toBe('my draft\nfirst')
  expect(choiceDraft('my draft\nfirst','second','first')).toBe('my draft\nsecond')
  expect(choiceDraft('my draft edited','second','first')).toBe('my draft edited\nsecond')
})
it('仅同会话同剧情同修订消息显示选项，点击只写草稿，忙碌时不覆盖',async()=>{
  const owner=Symbol(),setDraft=vi.fn(),submit=vi.fn();let phase='plain'
  const stop=installChoiceInput(()=>({setDraft,submit,state:{getSnapshot:()=>({draft:'keep',phase,occurrences:[]})}} as unknown as SessionInput))
  let view:ReactTestRenderer|undefined
  try{
    publishScriptChoices(owner,'session',context,0,[{label:'Pick',text:'choice'}])
    await act(async()=>{view=create(<ScriptChoices sessionId="other" context={context}/>)});expect(view!.toJSON()).toBe(null)
    await act(async()=>view!.update(<ScriptChoices sessionId="session" context={{...context,historyRevision:'new'}}/>));expect(view!.toJSON()).toBe(null)
    await act(async()=>view!.update(<ScriptChoices sessionId="session" context={context}/>))
    await act(async()=>view!.root.findByType(Btn).props.onClick());expect(setDraft).toHaveBeenCalledWith('keep\nchoice');expect(submit).not.toHaveBeenCalled()
    phase='submitting';await act(async()=>view!.root.findByType(Btn).props.onClick());expect(setDraft).toHaveBeenCalledTimes(1)
    await act(async()=>clearScriptChoices(owner));expect(view!.toJSON()).toBe(null)
  }finally{stop();clearScriptChoices(owner);if(view)await act(async()=>view!.unmount())}
})
