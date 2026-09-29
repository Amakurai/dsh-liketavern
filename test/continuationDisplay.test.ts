/** 真实消息形状的续写展示：机读命令跨消息闭合，只读清理尾段，普通输入和缓存保留。 */
import { expect,it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage,createUserMessage } from '@deepseek-ai/dsh-llm'
import { CONTINUE_INSTRUCTION_PREFIX } from '../src/core/dshPrompt.js'
import { continuationDisplayText } from '../src/core/continuationDisplay.js'
import { presentRenderedOutput } from '../src/core/displaySanitize.js'

function fixture(owned=true,prefix="普通台词<UpdateVariable>_.add('hp',"){
  const events:SessionEvent[]=[]
  const add=(type:string,data:unknown)=>events.push({type,data,seq:events.length,time:0,...(type==='assistant/message'?{surfaceOp:'append'}:{})} as SessionEvent)
  const assistant=(turn:number,text:string,reason='stop')=>{
    add('assistant/message',{turn,step:1,message:createAssistantMessage({content:[{type:'text',text}],source:{provider:'fixture',model:'fixture'}}),
      stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:reason}}}]})
    return events.at(-1)!.seq
  }
  const next=(turn:number)=>{add('turn/start',{turn});add('user/message',createUserMessage({content:[{type:'text',text:CONTINUE_INSTRUCTION_PREFIX+'继续'}],source:owned?{kind:'dsh-tavern',form:'notice',summary:'续写'}:{kind:'user'}}))}
  add('turn/start',{turn:1});assistant(1,prefix,'max-tokens');add('turn/end',{turn:1,reason:{kind:'completed'}})
  return {events,add,assistant,next}
}

it('只隐藏真正续写中的半条命令，当前可见台词与原历史保留',()=>{
  const f=fixture();f.next(2)
  const text='2);</UpdateVariable>续写后的台词',seq=f.assistant(2,text),before=JSON.stringify(f.events)
  expect(continuationDisplayText(f.events,seq,text,text)).toBe('续写后的台词')
  expect(JSON.stringify(f.events)).toBe(before)
  expect(continuationDisplayText(f.events,seq,'独立预览',text)).toBe(text)
  const ordinary=fixture(false);ordinary.next(2);const ordinarySeq=ordinary.assistant(2,text)
  expect(continuationDisplayText(ordinary.events,ordinarySeq,text,text)).toBe(text)
})

it('连续续写保持机读状态，已完成的第一步之后不重复借用旧前文',()=>{
  const f=fixture();f.next(2);f.assistant(2,'2);','max-tokens');f.add('turn/end',{turn:2,reason:{kind:'completed'}});f.next(3)
  const text='</UpdateVariable>最后台词',seq=f.assistant(3,text)
  expect(continuationDisplayText(f.events,seq,text,text)).toBe('最后台词')
  const step=f.assistant(3,'第二步台词')
  expect(continuationDisplayText(f.events,step,'第二步台词','第二步台词')).toBe('第二步台词')
})

it('展示使用已提交模板结果，仅收起跨消息协议，不重跑或吞掉卡面',()=>{
  const f=fixture();f.next(2)
  const raw='2);</UpdateVariable><%= committed %>',seq=f.assistant(2,raw)
  const html='<html><body><button>已物化卡面</button></body></html>'
  expect(continuationDisplayText(f.events,seq,raw,'2);</UpdateVariable>'+html)).toBe(html)
})

it('长聊天的正常续写以最近的正常回复为展示边界，不累计所有历史触发截断链预算',()=>{
  const f=fixture()
  let seq=0,text=''
  for(let turn=2;turn<=70;turn++){
    f.next(turn);text=turn===2?'2);</UpdateVariable>正常巡逻完成。':'第 '+turn+' 次正常巡逻。';seq=f.assistant(turn,text)
    f.add('turn/end',{turn,reason:{kind:'completed'}})
  }
  expect(continuationDisplayText(f.events,seq,text,text)).toBe(text)
})

/** 卡片只在续写完成的消息中物化，完整前文不重复，源消息和变量命令保持只读。 */
it('跨多次截断拼回完整卡片，仅保留未完成的 HTML 和当前台词',()=>{
  const completed='<div>之前的完整卡</div>'
  const prefix='<!doctype html><html><body><button id="counter">计数</button><script>window.count='
  const f=fixture(true,completed+'\n之前的台词。\n'+prefix)
  f.next(2);f.assistant(2,'1;','max-tokens');f.add('turn/end',{turn:2,reason:{kind:'completed'}});f.next(3)
  const tail="</script></body></html>\n当前台词。<UpdateVariable>_.add('hp',1);</UpdateVariable>"
  const seq=f.assistant(3,tail),before=JSON.stringify(f.events)
  const visible=presentRenderedOutput(continuationDisplayText(f.events,seq,tail,tail),true)
  expect(visible).toEqual({text:'当前台词。',html:prefix+'1;</script></body></html>',htmls:[prefix+'1;</script></body></html>']})
  expect(JSON.stringify(f.events)).toBe(before)
  f.add('turn/end',{turn:3,reason:{kind:'completed'}});f.next(4)
  const next=f.assistant(4,'下一轮台词')
  expect(continuationDisplayText(f.events,next,'下一轮台词','下一轮台词')).toBe('下一轮台词')
})

it.each([
  ['```html\n<div><button>按钮', '</button></div>\n```', '<div><button>按钮</button></div>'],
  ['<div><button id="x">按钮</button></div><script>document.getElementById("x").onclick=()=>', '{};</script>', '<div><button id="x">按钮</button></div><script>document.getElementById("x").onclick=()=>{};</script>'],
])('围栏和相邻脚本跨消息闭合后仍留在同一卡面：%s',(prefix,tail,html)=>{
  const f=fixture(true,'旧台词\n'+prefix);f.next(2);const seq=f.assistant(2,tail)
  expect(presentRenderedOutput(continuationDisplayText(f.events,seq,tail,tail),true).htmls).toEqual([html])
})

it('已完成卡片不随续写重复执行，普通用户输入不能借用前一张卡',()=>{
  const prefix='<div>旧卡</div>',f=fixture(true,prefix);f.next(2)
  const seq=f.assistant(2,'新台词')
  expect(continuationDisplayText(f.events,seq,'新台词','新台词')).toBe('新台词')
  const user=fixture(false,'<div>');user.next(2);const tail='普通内容</div>',userSeq=user.assistant(2,tail)
  expect(continuationDisplayText(user.events,userSeq,tail,tail)).toBe(tail)
})

it('跨消息卡片只能复用已提交的模板结果，缺失快照明确失败',()=>{
  const f=fixture(true,'<% print("<div>模板卡片") %>');f.next(2)
  const tail='尾部</div>',seq=f.assistant(2,tail)
  expect(continuationDisplayText(f.events,seq,tail,tail,()=>'<div>已提交卡片')).toBe('<div>已提交卡片尾部</div>')
  expect(()=>continuationDisplayText(f.events,seq,tail,tail,()=>undefined)).toThrow('模板尚未提交')
  expect(()=>continuationDisplayText(f.events,seq,tail,tail,()=>'<div>'+'灯'.repeat(90000))).toThrow('256 KiB')
})

it('更早的未提交模板不属于待补全卡面时，不阻断后续纯 HTML 续写',()=>{
  const f=fixture(true,'<% print("旧台词") %>');f.next(2)
  const prefix=f.assistant(2,'<div>卡面','max-tokens');f.add('turn/end',{turn:2,reason:{kind:'completed'}});f.next(3)
  const tail='尾部</div>',seq=f.assistant(3,tail)
  expect(continuationDisplayText(f.events,seq,tail,tail,event=>event.seq===prefix?'<div>卡面':undefined)).toBe('<div>卡面尾部</div>')
})

/** 真实输出上限可落在任意字符；按每个切分点验证，不能只覆盖标签之间的理想边界。 */
it.each([
  '<html><body><button id="count">计数</button><script>window.count=1;</script></body></html>',
  '<!doctype html><html><body><button>计数</button></body></html>',
  '```html\n<button id="count">计数</button><script>window.count=1;</script>\n```',
])('任意字符截断的卡面续写保持完整展示：%s',html=>{
  const expected=presentRenderedOutput(html,true)
  for(let at=1;at<html.length;at++){
    const first=html.slice(0,at),tail=html.slice(at),f=fixture(true,'旧台词\n'+first);f.next(2)
    const seq=f.assistant(2,tail)
    const visible=presentRenderedOutput(continuationDisplayText(f.events,seq,tail,tail),true)
    const previous=presentRenderedOutput(first,true)
    // HTML 允许省略最后的 </html>。前文已经构成完整卡面时，只收起补写闭标签，不运行第二张卡。
    expect(visible,'截断位置 '+at+'，前文 '+first).toEqual(previous.htmls.length&&!previous.pendingHtml
      ? {html:null,htmls:[],text:''}:expected)
  }
})

it.each([
  ['说明\n```js\nconst example = "','<html><body><button>只是示例</button></body></html>";\n```'],
  ['说明\n~~~javascript\nconst example = "','<div><button>只是示例</button></div>";\n~~~'],
  ['内联示例：`','<html><body><button>只是示例</button></body></html>`，继续说明'],
])('普通代码示例的续写不能提升成可运行卡片：%s',(prefix,tail)=>{
  const f=fixture(true,prefix);f.next(2);const seq=f.assistant(2,tail)
  const visible=presentRenderedOutput(continuationDisplayText(f.events,seq,tail,tail),true)
  expect(visible.htmls).toEqual([])
  expect(visible.pendingHtml).toBeUndefined()
  expect(visible.text).toContain('只是示例')
  expect(visible.text).not.toContain('说明\n')
})

it.each([
  '```javascript\nconst example = "<html><body><button>示例</button></body></html>";\n```',
  '~~~js\nconst example = "<div><button>示例</button></div>";\n~~~',
  '`<html><body><button>示例</button></body></html>`',
  '``<div title="`">示例</div>``',
])('代码示例每个字符的截断都不会变成卡面：%s',source=>{
  for(let at=1;at<source.length;at++){
    const f=fixture(true,'说明\n'+source.slice(0,at)),tail=source.slice(at);f.next(2);const seq=f.assistant(2,tail)
    const shown=presentRenderedOutput(continuationDisplayText(f.events,seq,tail,tail),true)
    expect(shown.htmls,'截断位置 '+at).toEqual([])
    expect(shown.pendingHtml,'截断位置 '+at).toBeUndefined()
  }
})

it('代码块结束后的独立卡片仍可运行，代码内部的 HTML 不进入沙箱',()=>{
  const f=fixture(true,'```js\nconst example="');f.next(2)
  const html='<div><button>真实卡片</button></div>',tail='<html><body>只读示例</body></html>";\n```\n台词\n'+html,seq=f.assistant(2,tail)
  const shown=presentRenderedOutput(continuationDisplayText(f.events,seq,tail,tail),true)
  expect(shown.htmls).toEqual([html]);expect(shown.text).toContain('只读示例');expect(shown.text).toContain('台词')
})

it('跨消息的真实脚本保留模板字符串及协议标签字面量，外部 MVU 命令仍隐藏',()=>{
  const html='<html><body><button>卡片</button><script>const example=`<UpdateVariable>文本</UpdateVariable>`;</script></body></html>'
  for(let at=1;at<html.indexOf('</script>');at++){
    const f=fixture(true,'旧台词\n'+html.slice(0,at)),tail=html.slice(at)+'<UpdateVariable>_.add("hp",1);</UpdateVariable>'
    f.next(2);const seq=f.assistant(2,tail)
    const shown=presentRenderedOutput(continuationDisplayText(f.events,seq,tail,tail),true)
    expect(shown,'截断位置 '+at).toEqual({html,htmls:[html],text:''})
  }
})
