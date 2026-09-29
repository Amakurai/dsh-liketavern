/** 续写展示的跨消息机读边界：只读真实 notice 与原文，隐藏命令尾段，不修改历史或重跑模板。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { isContinueInstruction } from './dshPrompt.js'
import { findIncompleteHtmlStart, stripContinuedDisplayMetaParts } from './displaySanitize.js'
import { hasNormalAssistantStop } from './assistantStream.js'
import { isTavernNotice } from './messageSources.js'
import { locateRenderedHtml } from './regex.js'
import { continuedMarkdown } from './continuationMarkdown.js'

type Assistant = SessionEvent<'assistant/message'>
/** undefined 表示该来源的模板没有可用提交快照，不能借显示刷新重新求值。 */
type SourceText=(event:Assistant)=>string|undefined
interface Turn { previous?: Assistant; notice?: number; firstStop?: number }
interface Index { length:number; last?:SessionEvent; turns:Map<number,Turn>; messages:Map<number,Assistant> }
const indexes=new WeakMap<readonly SessionEvent[],Index>()
const body=(event:Assistant)=>event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')

/** 一份宿主快照只索引一次，打开长聊天不会为每个气泡再次遍历全部消息。 */
function indexOf(events:readonly SessionEvent[]):Index {
  const known=indexes.get(events),last=events.at(-1)
  if(known?.length===events.length&&known.last===last)return known
  const index:Index={length:events.length,last,turns:new Map(),messages:new Map()}
  let previous:Assistant|undefined,turn:Turn|undefined
  for(const event of events){
    if(event.type==='turn/start'){
      turn={previous};index.turns.set(event.data.turn,turn)
    }else if(event.type==='user/message'&&turn&&(event.surfaceOp===undefined||event.surfaceOp==='append')
      &&isTavernNotice(event.data.source)&&isContinueInstruction(event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'))){
      turn.notice??=event.seq
    }else if(event.type==='assistant/message'&&(event.surfaceOp===undefined||event.surfaceOp==='append')&&body(event).trim()){
      index.messages.set(event.seq,event);previous=event
      if(hasNormalAssistantStop(event)){
        const owner=index.turns.get(event.data.turn)
        if(owner)owner.firstStop??=event.seq
      }
    }
  }
  indexes.set(events,index);return index
}

/**
 * 单个 < 或围栏前两个反引号没有足够信息判断为卡面；新文本到达后按完整 Markdown
 * 边界确认跨消息单元。完整的旧卡面不复制，只收起其后补写的可省略文档闭标签。
 */
function continuedHtml(previous:string,current:string,codeStart?:number):{start:number}|{skip:number}|undefined {
  const pending=findIncompleteHtmlStart(previous)
  if(pending!==null&&(codeStart===undefined||pending<codeStart))return {start:pending}
  if(!current)return undefined
  const joined=previous+current,boundary=previous.length
  let offset=0
  for(let count=0;count<128;count++){
    const located=locateRenderedHtml(joined.slice(offset))
    if(!located)break
    const start=offset+(located.fence?.start??located.start)
    const end=offset+(located.fence?.end??located.start+located.html.length)
    if(start>=boundary)break
    if(end>boundary){
      const old=locateRenderedHtml(previous.slice(start))
      if(!old||(old.fence?.start??old.start)>0)return {start}
      const closing=/^\s*<\/html\s*>/i.exec(current)
      if(!old.fence&&/<\/body\s*>\s*$/i.test(old.html)&&closing
        &&!previous.slice(start+old.start+old.html.length).trim())return {skip:closing[0].length}
      return undefined
    }
    offset=end
  }
  const start=findIncompleteHtmlStart(joined)
  if(start===null||start>=boundary)return undefined
  const old=locateRenderedHtml(previous.slice(start))
  return !old||(old.fence?.start??old.start)>0?{start}:undefined
}

export function continuationDisplayText(events:readonly SessionEvent[],seq:number,raw:string,rendered:string,sourceText?:SourceText):string {
  const index=indexOf(events)
  const target=index.messages.get(seq)
  // 独立预览或不匹配的文本不能借用真实消息的展示边界。
  if(!target||body(target)!==raw)return rendered
  return continuationStreamText(events,target.data.turn,seq,rendered,sourceText)
}

/** 流式正文还没有持久 seq；只读公开事件快照中的真实续写 notice 和此前消息。 */
export function continuationStreamText(events:readonly SessionEvent[],turnNumber:number,seq:number|undefined,rendered:string,sourceText?:SourceText):string {
  const index=indexOf(events)
  let target={turn:turnNumber,seq:seq??Infinity}
  const prefix:{text:string;unavailable:boolean}[]=[]
  const encoder=new TextEncoder()
  let bytes=encoder.encode(rendered).length
  for(let depth=0;;depth++){
    const turn=index.turns.get(target.turn)
    if(turn?.notice===undefined||turn.notice>=target.seq||turn.firstStop!==undefined&&turn.firstStop<target.seq||!turn.previous)break
    if(depth>=64)throw new Error('续写展示来源超过 64 层预算')
    const raw=body(turn.previous),materialized=sourceText?sourceText(turn.previous):raw,text=materialized??raw
    bytes+=encoder.encode(text).length
    if(bytes>256*1024)throw new Error('续写展示正文超过 256 KiB')
    prefix.push({text,unavailable:materialized===undefined})
    // 正常 stop 是旧续写链的收口；仍检查这条回复自身的 opener，但不累计更早的完整历史。
    if(hasNormalAssistantStop(turn.previous))break
    target={turn:turn.previous.data.turn,seq:turn.previous.seq}
  }
  if(!prefix.length)return rendered
  const parts=stripContinuedDisplayMetaParts([...prefix.reverse(),{text:rendered,unavailable:false}])
  const before=parts.slice(0,-1),previous=before.map(part=>part.text).join(''),current=parts.at(-1)!.text
  const code=continuedMarkdown(previous,current),html=continuedHtml(previous,current,code?.start)
  if(!html)return code?.text??current
  if('skip' in html)return current.slice(html.skip)
  const pending=html.start
  let offset=0
  for(const part of before){
    offset+=part.text.length
    if(offset>pending&&part.unavailable)throw new Error('续写卡面前文中的模板尚未提交，不能在显示刷新时重新执行')
  }
  return previous.slice(pending)+current
}
