/** 宿主文本历史的稳定身份投影：只遍历 deriveMessages 的可见消息，pending 按原始 Message.id 抵消。 */
import type { Message } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'
import type { ChatMessage } from '../core/types.js'
import type { TemplateMessageIdentity } from '../core/templateMessageVariables.js'
import { isSyntheticUserText } from '../core/dshPrompt.js'

export function buildTemplateMessageHistory(messages:readonly Message[],pending:readonly {id:string;text:string}[],charName:string,userName:string,events:readonly SessionEvent[]=[]) {
  const visible=new Set(messages.map(message=>String(message.id)))
  const seqs=new Map<string,number>()
  for(const event of events) {const message=deriveEventMessage(event);if(message && visible.has(message.id)) seqs.set(message.id,event.seq)}
  const history:ChatMessage[]=[],identities:TemplateMessageIdentity[]=[]
  const seen=new Set<string>()
  const add=(id:string,role:ChatMessage['role'],content:string)=>{
    if(!content.trim() || role==='user' && isSyntheticUserText(content) || seen.has(id)) return
    seen.add(id)
    const name=role==='assistant' ? charName : role==='user' ? userName : undefined
    history.push({role,content,...(name ? {name} : {})})
    const seq=seqs.get(id)
    identities.push({messageId:id,swipeId:0,...(seq!==undefined ? {hostMessageId:seq} : {})})
  }
  for(const message of messages) add(message.id,message.role,message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'))
  for(const message of pending) add(message.id,'user',message.text)
  return {history,identities}
}
