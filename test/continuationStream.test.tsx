/** 真实宿主事件源配 React 流式续写：未闭合命令不闪现、来源切换不串线、超限错误不破坏聊天树。 */
import {act,create,type ReactTestRenderer} from 'react-test-renderer'
import {afterEach,expect,it} from 'vitest'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {MutableSessionEventSource} from '../node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/events.js'
import {CONTINUE_INSTRUCTION_PREFIX} from '../src/core/dshPrompt.js'
import {useContinuationStream} from '../src/client/continuationStream.js'
import {presentStreamingOutput} from '../src/core/displaySanitize.js'

const mounted:ReactTestRenderer[]=[]
afterEach(async()=>{for(const view of mounted.splice(0))await act(async()=>view.unmount())})
function fixture(owned=true,prefix="台词<UpdateVariable>_.add('hp',"){
  const source=new MutableSessionEventSource(),events:SessionEvent[]=[]
  const add=(type:string,data:unknown)=>{
    const event={type,data,seq:events.length,time:0,...(type.endsWith('/message')?{surfaceOp:'append'}:{})} as SessionEvent
    events.push(event);source.append({type:'event',event});return event.seq
  }
  add('turn/start',{turn:1})
  add('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:prefix}],source:{provider:'fixture',model:'fixture'}}),stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'max-tokens'}}}]})
  add('turn/end',{turn:1,reason:{kind:'completed'}});add('turn/start',{turn:2})
  add('user/message',createUserMessage({content:[{type:'text',text:CONTINUE_INSTRUCTION_PREFIX+'继续'}],source:owned?{kind:'dsh-tavern',form:'notice',summary:'续写'}:{kind:'user'}}))
  return {source,add,events}
}
function Preview(props:{source?:MutableSessionEventSource;text:string;seq?:number}){
  const value=useContinuationStream(props.source,2,props.seq,props.text)
  return <div data-text={value.text} data-error={value.error}/>
}
async function mount(props:Parameters<typeof Preview>[0]){
  let view!:ReactTestRenderer
  await act(async()=>{view=create(<Preview {...props}/>)});mounted.push(view);return view
}

it('从首个流式字符到持久化收口都不露出半条命令，原消息保留',async()=>{
  const f=fixture(),before=JSON.stringify(f.events),view=await mount({source:f.source,text:'2);'})
  expect(view.root.findByType('div').props['data-text']).toBe('')
  const text='2);</UpdateVariable>巡逻完成'
  await act(async()=>view.update(<Preview source={f.source} text={text}/>))
  expect(view.root.findByType('div').props['data-text']).toBe('巡逻完成')
  expect(JSON.stringify(f.events)).toBe(before)
  await act(async()=>{
    const seq=f.add('assistant/message',{turn:2,step:1,message:createAssistantMessage({content:[{type:'text',text}],source:{provider:'fixture',model:'fixture'}}),stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'stop'}}}]})
    view.update(<Preview source={f.source} text={text} seq={seq}/>)
  })
  expect(view.root.findByType('div').props['data-text']).toBe('巡逻完成')
})

it('用户仿写 notice 与切换后的其它会话不借用旧消息边界',async()=>{
  const original=fixture(),other=fixture(false),text='2);</UpdateVariable>新会话',view=await mount({source:original.source,text})
  expect(view.root.findByType('div').props['data-text']).toBe('新会话')
  await act(async()=>view.update(<Preview source={other.source} text={text}/>))
  expect(view.root.findByType('div').props['data-text']).toBe(text)
  await act(async()=>original.add('turn/start',{turn:99}))
  expect(view.root.findByType('div').props['data-text']).toBe(text)
})

it('超出累计预算返回显示错误，不把命令回退成正文或抛出 React 渲染异常',async()=>{
  const f=fixture(true,'灯'.repeat(90000)+'<UpdateVariable>'),view=await mount({source:f.source,text:'_.add("hp",2)'})
  expect(view.root.findByType('div').props).toMatchObject({'data-text':'','data-error':expect.stringContaining('256 KiB')})
})

it('跨消息卡片续写中的脚本尾段持续等待完整显示，事件源切换不借用旧卡',async()=>{
  const prefix='<html><body><button>按钮</button><script>window.count='
  const f=fixture(true,'旧台词\n'+prefix),view=await mount({source:f.source,text:'1;'})
  const shown=()=>presentStreamingOutput(view.root.findByType('div').props['data-text'],true)
  expect(shown()).toEqual({text:'',pendingHtml:true})
  const tail='1;</script></body></html>新台词'
  await act(async()=>view.update(<Preview source={f.source} text={tail}/>))
  expect(shown()).toEqual({text:'',pendingHtml:true})
  const other=fixture(true,'普通回复')
  await act(async()=>view.update(<Preview source={other.source} text="新会话内容"/>))
  expect(shown()).toEqual({text:'新会话内容',pendingHtml:false})
})

it('普通代码块中的流式 HTML 续写继续作为示例显示',async()=>{
  const f=fixture(true,'说明\n```js\nconst example = "'),view=await mount({source:f.source,text:'<html><body>只读示例'})
  const shown=()=>presentStreamingOutput(view.root.findByType('div').props['data-text'],true)
  expect(shown().pendingHtml).toBe(false);expect(shown().text).toContain('只读示例')
  await act(async()=>view.update(<Preview source={f.source} text={'<html><body>只读示例</body></html>";\n```\n新的台词'}/>))
  expect(shown().pendingHtml).toBe(false);expect(shown().text).toContain('新的台词')
})
