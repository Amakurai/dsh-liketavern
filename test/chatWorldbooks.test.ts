/** 聊天世界书集合编码：原生视图只含活动书，闲置书可恢复，坏集合与超量数据拒绝。 */
import {expect,it} from 'vitest'
import {CHAT_WORLDBOOK_META,chatWorldbookId,chatWorldbookRef,decodeChatWorldbooks,encodeChatWorldbooks,parseChatWorldbookFile} from '../src/state/chatWorldbooks.js'
import {parseLorebook} from '../src/state/lorebook.js'
const book=(content:string)=>({name:content,entries:{0:{uid:0,content,constant:true}}})
it('旧单书不需要迁移写入，切换和解绑只改变活动视图而保留其它书',()=>{
  const store=decodeChatWorldbooks(book('main'));expect(store.active).toBe('main')
  store.books.set('second',book('second'));store.active='second'
  const encoded=encodeChatWorldbooks(store)
  expect(parseLorebook(encoded,{source:'chat',sourceRef:'chat'}).map(entry=>entry.content)).toEqual(['second'])
  const restored=decodeChatWorldbooks(encoded);expect(restored.books.get('main')).toEqual(book('main'))
  restored.active=null
  const detached=encodeChatWorldbooks(restored)
  expect(parseLorebook(detached,{source:'chat',sourceRef:'chat'})).toEqual([])
  expect(decodeChatWorldbooks(detached).books.size).toBe(2)
})
it('目录标识不成为路径，损坏活动副本、非法闲置书和 65 本集合明确拒绝',()=>{
  expect(chatWorldbookRef('main')).toBe('@dsh/chat');expect(chatWorldbookId('@dsh/chat/source-1')).toBe('source-1')
  expect(()=>chatWorldbookId('@dsh/chat/../../private')).toThrow()
  for(const value of [{active:'main',books:{main:book('duplicate')}},{active:null,books:{bad:null}},{active:'../bad',books:{}}])expect(()=>decodeChatWorldbooks({...book('active'),[CHAT_WORLDBOOK_META]:{version:1,...value}})).toThrow()
  expect(()=>parseChatWorldbookFile('null')).toThrow(/损坏/)
  const store={active:null,books:new Map(Array.from({length:65},(_,i)=>['book-'+i,book('bounded')]))}
  expect(()=>encodeChatWorldbooks(store)).toThrow(/64/)
})
it('解析前体量闸：被篡改的超大文件在 JSON.parse 前拒绝',()=>{
  // 写路径按 32MiB 值预算封顶，但以 2 空格美化落盘；闸门按 2.5 倍预算放行合法美化文件，
  // 超限的篡改文件在无界读取与 JSON.parse 前直接失败。
  expect(()=>parseChatWorldbookFile(' '.repeat(96*1024*1024))).toThrow(/超限/)
  expect(()=>parseChatWorldbookFile('null')).toThrow(/损坏/)
})
