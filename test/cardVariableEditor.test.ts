/** 变量编辑器运行真实注入函数和 Zod schema；验证只有 UI 受约束、转换回执、并发草稿与重装边界。 */
import {createContext,runInContext} from 'node:vm'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {buildSync} from 'esbuild'
import {installCardVariables} from '../src/core/cardVariables.js'
import {installCardHelper} from '../src/core/cardHelper.js'
import {installCardPersistence} from '../src/core/cardPersistence.js'

// 与交付一致，schema 库和异步 refinement 在同一沙箱 realm；不让宿主 Promise 冒充 iframe Promise。
const schemaLibrary=buildSync({stdin:{contents:"import {z} from 'zod';Object.assign(window,{z})",resolveDir:process.cwd()},
  bundle:true,format:'iife',platform:'browser',write:false}).outputFiles[0]!.text

class Element {
  id='';textContent='';value='';disabled=false;hidden=false;readOnly=false;type=''
  parent?:Element
  children:Element[]=[]
  attributes=new Map<string,string>()
  onclick?:()=>void;onchange?:()=>void;oninput?:()=>void
  append(...nodes:Element[]){for(const node of nodes){node.parent=this;this.children.push(node)}}
  appendChild(node:Element){this.append(node)}
  prepend(node:Element){node.parent=this;this.children.unshift(node)}
  after(node:Element){if(this.parent){node.parent=this.parent;this.parent.children.splice(this.parent.children.indexOf(this)+1,0,node)}}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this)}
  setAttribute(key:string,value:string){this.attributes.set(key,value)}
  focus(){} select(){}
  all():Element[]{return [this,...this.children.flatMap(child=>child.all())]}
}
function frame(){
  const body=new Element(),postMessage=vi.fn()
  const parent={postMessage},listeners=new Set<(event:unknown)=>void>()
  const scope:Record<string,unknown>={TextEncoder,setTimeout,clearTimeout,queueMicrotask,parent,
    crypto:globalThis.crypto,
    addEventListener:(type:string,listener:(event:unknown)=>void)=>{if(type==='message')listeners.add(listener)},
    removeEventListener:(_type:string,listener:(event:unknown)=>void)=>listeners.delete(listener),
    document:{readyState:'complete',body,head:new Element(),createElement:()=>new Element(),
      getElementById:(id:string)=>body.all().find(node=>node.id===id),addEventListener:vi.fn(),removeEventListener:vi.fn()}}
  scope.window=scope
  const context=createContext(scope),run=(code:string)=>runInContext(code,context)
  run(schemaLibrary)
  const install=()=>run(`(${installCardVariables.toString()})({title:'Backup',note:'Note',backup:'Export',text:'Backup JSON'},'',2,4,true)`)
  install()
  const find=(label:string)=>body.all().find(node=>node.textContent===label||node.attributes.get('aria-label')===label)!
  const click=(label:string)=>{const button=find(label);expect(button).toBeDefined();expect(button.disabled).toBe(false);button.onclick!()}
  const edit=(text:string)=>{const input=find('Variables JSON');input.value=text;input.oninput!()}
  const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))
  const select=(type:string,target?:string)=>{
    const radio=body.all().find(node=>node.type==='radio'&&node.value===type)!;radio.onchange!()
    if(target!==undefined){const input=find('Message ID or latest').children[0]!;input.value=target;input.onchange!()}
  }
  return {run,body,postMessage,install,find,click,edit,settle,select,
    reply:(data:unknown,source:unknown=parent)=>{for(const listener of listeners)listener({source,data})}}
}
afterEach(()=>vi.useRealTimers())

describe('卡面变量结构和 JSON 编辑器',()=>{
  it('Zod 转换只约束编辑器，校验不改变量，保存等待真实 flush 回执且不序列化 schema',async()=>{
    const f=frame()
    f.run('registerVariableSchema(z.object({hp:z.coerce.number().int().min(0)}),{type:"chat"});replaceVariables({hp:"program can bypass",extra:true})')
    expect(f.run('getVariables()')).toEqual({hp:'program can bypass',extra:true})
    f.click('Load JSON');f.edit('{"hp":"7","ignored":"field"}')
    f.click('Validate');await f.settle();expect(f.find('Valid')).toBeDefined();expect(f.run('getVariables().hp')).toBe('program can bypass')
    f.run('window.flushes=0;window.flushHelperVariables=()=>{flushes++;return new Promise(resolve=>window.saved=resolve)}')
    f.click('Save');await f.settle()
    expect(f.run('getVariables()')).toEqual({hp:7});expect(f.run('flushes')).toBe(1)
    expect(f.find('Saving')).toBeDefined();expect(f.run('__dshTavernVariableEditorDirty()')).toBe(true)
    f.run('saved()');await f.settle();expect(f.find('Saved')).toBeDefined();expect(f.run('__dshTavernVariableEditorDirty()')).toBe(false)
    expect(JSON.parse(f.find('Variables JSON').value)).toEqual({hp:7});expect(f.postMessage).not.toHaveBeenCalled()
  })
  it('结构错误和非 JSON 转换保留原表与草稿；显式丢弃后可以重载',async()=>{
    const f=frame();f.run('replaceVariables({hp:4});registerVariableSchema(z.object({hp:z.number().min(0)}),{type:"chat"})')
    f.click('Load JSON');f.edit('{"hp":-1}');f.click('Save');await f.settle()
    expect(f.run('getVariables()')).toEqual({hp:4});expect(f.find('Variables JSON').value).toBe('{"hp":-1}')
    expect(f.body.all().some(node=>node.attributes.get('role')==='alert'&&node.textContent.includes('Not saved'))).toBe(true)
    for(const expression of ['{callback:()=>1}','{missing:undefined}','{date:new Date()}','{n:NaN}','Object.create(Object.create(null))']){
      f.run(`registerVariableSchema(z.unknown().transform(()=>(${expression})),{type:"chat"})`)
      f.click('Save');await f.settle();expect(f.run('getVariables()')).toEqual({hp:4})
    }
    f.click('Discard draft');expect(JSON.parse(f.find('Variables JSON').value)).toEqual({hp:4});expect(f.run('__dshTavernVariableEditorDirty()')).toBe(false)
  })
  it.each(['table','history','schema','text'])('异步结构校验期间 %s 变化拒绝覆盖',async(change)=>{
    const f=frame();f.run('replaceVariables({hp:1});registerVariableSchema(z.object({hp:z.number()}).superRefine(async()=>{await new Promise(resolve=>window.release=resolve)}),{type:"chat"})')
    f.click('Load JSON');f.edit('{"hp":2}');f.click('Save');await f.settle()
    if(change==='table')f.run('replaceVariables({hp:9})')
    if(change==='history')f.run('window.__dshTavernSnapshotGeneration=1')
    if(change==='schema')f.run('registerVariableSchema(z.object({hp:z.number()}),{type:"chat"})')
    if(change==='text')f.edit('{"hp":3}')
    f.run('release()');await f.settle()
    expect(f.run('getVariables().hp')).toBe(change==='table'?9:1)
    expect(f.find('Variables JSON').value).toBe(change==='text'?'{"hp":3}':'{"hp":2}')
    expect(f.body.all().some(node=>node.textContent.includes('Variables or history changed'))).toBe(true)
  })
  it('保存失败保留 JSON，保存回执期间的新编辑继续作为草稿而不被转换结果覆盖',async()=>{
    const f=frame();f.run('replaceVariables({hp:1});window.flushHelperVariables=async()=>{throw Error("fixture disk failure")}')
    f.click('Load JSON');f.edit('{"hp":2}');f.click('Save');await f.settle()
    expect(f.find('Variables JSON').value).toBe('{"hp":2}');expect(f.run('__dshTavernVariableEditorDirty()')).toBe(true)
    expect(f.body.all().some(node=>node.textContent.includes('fixture disk failure'))).toBe(true)
    f.run('window.flushHelperVariables=()=>new Promise(resolve=>window.saved=resolve)')
    f.click('Save');await f.settle();f.edit('{"hp":3}');f.run('saved()');await f.settle()
    expect(f.run('getVariables()')).toEqual({hp:2});expect(f.find('Variables JSON').value).toBe('{"hp":3}')
    expect(f.run('__dshTavernVariableEditorDirty()')).toBe(true)
    f.run('window.flushHelperVariables=async()=>{}');f.click('Save');await f.settle();expect(f.run('getVariables()')).toEqual({hp:3})
  })
  it('目标按实际消息编号固定，最新消息不会误写到其它 scope，重装后旧校验不能提交',async()=>{
    const f=frame();f.run('replaceVariables({hp:1},{type:"message",message_id:3});registerVariableSchema(z.object({hp:z.coerce.number()}),{type:"message"})')
    f.select('message','latest');f.click('Load JSON');f.edit('{"hp":"8"}');f.click('Save');await f.settle()
    expect(f.run('getVariables({type:"message",message_id:3})')).toEqual({hp:8});expect(f.run('getVariables()')).toEqual({})
    expect(f.find('Saved in this frame; export a backup before closing')).toBeDefined()
    f.run('registerVariableSchema(z.object({hp:z.number()}).superRefine(async()=>{await new Promise(resolve=>window.release=resolve)}),{type:"message"})')
    f.edit('{"hp":9}');f.click('Save');await f.settle();f.install();f.run('release()');await f.settle()
    expect(f.run('getVariables({type:"message",message_id:3})')).toEqual({hp:8})
    expect(f.body.all().filter(node=>node.id==='dsh-tavern-variable-editor')).toHaveLength(1)
  })
  it('卡面助手安装不会覆盖结构注册，非法 scope 与超限 JSON 不影响原数据',async()=>{
    const f=frame()
    f.run(`(${installCardHelper.toString()})({scriptFrame:true},[],0,'dsh-tavern-card',{diagnostics:'Diagnostics',unsupported:'Unsupported'})`)
    f.run('registerVariableSchema(z.object({hp:z.number()}),{type:"chat"});replaceVariables({hp:2})')
    for(const code of ['registerVariableSchema({}, {type:"chat"})','registerVariableSchema(z.object({}),{type:"script"})','registerVariableSchema(z.object({}),{type:"chat",extra:true})'])expect(()=>f.run(code)).toThrow()
    f.click('Load JSON');f.edit('{"text":"'+'x'.repeat(1024*1024)+'"}');f.click('Save');await f.settle()
    expect(f.run('getVariables()')).toEqual({hp:2});expect(f.body.all().some(node=>node.textContent.includes('exceed 1 MiB'))).toBe(true)
  })
  it('卡住的异步 schema 在预算内失败，迟到结果不写变量',async()=>{
    vi.useFakeTimers({toFake:['setTimeout','clearTimeout']})
    const f=frame();f.run('replaceVariables({hp:1});registerVariableSchema(z.object({hp:z.number()}).superRefine(async()=>{await new Promise(resolve=>window.release=resolve)}),{type:"chat"})')
    f.click('Load JSON');f.edit('{"hp":2}');f.click('Save');await f.settle();await vi.advanceTimersByTimeAsync(15001)
    expect(f.body.all().some(node=>node.textContent.includes('validation timed out'))).toBe(true)
    f.run('release()');await f.settle();expect(f.run('getVariables()')).toEqual({hp:1});expect(f.run('__dshTavernVariableEditorDirty()')).toBe(true)
  })
  it.each([true,false])('编辑器实际持久层回执 success=%s，只发送 JSON 变量差异并保留失败草稿',async(success)=>{
    const f=frame()
    const snapshot={storyId:'story',historyRevision:'revision',currentMessageId:2,messages:[{},{},{}],scopes:{'["chat",""]':{hp:1}},writable:true}
    f.run(`window.snapshot=${JSON.stringify(snapshot)};window.__dshTavernSnapshot=snapshot;window.__dshTavernVariables.scopes=JSON.parse(JSON.stringify(snapshot.scopes))`)
    f.run(`window.stopPersistence=(${installCardPersistence.toString()})(snapshot,'dsh-tavern-card',{saving:'Persistence saving',saved:'Persistence saved',failed:'Persistence failed'})`)
    try{
      f.run('registerVariableSchema(z.object({hp:z.coerce.number()}),{type:"chat"})')
      f.click('Load JSON');f.edit('{"hp":"5"}');f.click('Save');await f.settle()
      expect(f.postMessage).toHaveBeenCalledTimes(1)
      const request=f.postMessage.mock.calls[0]![0] as Record<string,unknown>
      expect(request).toMatchObject({source:'dsh-tavern-card',action:'helperVariablesCommit',storyId:'story',historyRevision:'revision',changes:[{key:'["chat",""]',before:{hp:1},value:{hp:5}}]})
      const response={source:'dsh-tavern-card',action:'helperVariablesResult',requestId:request.requestId,ok:success,scopes:{'["chat",""]':{hp:5}},error:'fixture persistence refused'}
      f.reply(response,{});await f.settle();expect(f.run('getHelperPersistenceStatus()')).toBe('pending')
      f.reply(response);await f.settle()
      expect(f.run('getHelperPersistenceStatus()')).toBe(success?'saved':'error')
      expect(f.run('__dshTavernVariableEditorDirty()')).toBe(!success)
      if(success)expect(JSON.parse(f.find('Variables JSON').value)).toEqual({hp:5})
      else{expect(f.find('Variables JSON').value).toBe('{"hp":"5"}');expect(f.body.all().some(node=>node.textContent.includes('fixture persistence refused'))).toBe(true)}
    }finally{f.run('stopPersistence()')}
  })
})
