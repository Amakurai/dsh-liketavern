/** 重放数组前缀的纯函数边界：验证追加、短前缀、分叉与可变对象，不把不同 JSON 序列当成同一历史。 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { TemplateReplayArrayPrefixes } from '../src/core/templateReplayArrays.js'

const fingerprint=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const prefixes=()=>new TemplateReplayArrayPrefixes(fingerprint)

describe('重放数组严格前缀',()=> {
  it('同长序列与较短前缀引用同一数组，短前缀不截断已记住的后续值',()=> {
    const index=prefixes()
    index.remember('history',7,['甲','乙','丙'])
    expect(index.match('history',['甲','乙','丙'])).toEqual({index:7,length:3,suffix:[]})
    expect(index.match('history',['甲'])).toEqual({index:7,length:1,suffix:[]})
    expect(index.match('history',[])).toEqual({index:7,length:0,suffix:[]})
    expect(index.match('history',['甲','替换'])).toBeUndefined()
    expect(index.match('history',['甲','乙','丙'])).toEqual({index:7,length:3,suffix:[]})
  })

  it('只返回新增后缀，并在下一次匹配时识别已经追加的值',()=> {
    const index=prefixes()
    index.remember('history',3,['甲'])
    expect(index.match('history',['甲','乙','丙'])).toEqual({index:3,length:3,suffix:['乙','丙']})
    expect(index.match('history',['甲','乙','丙','丁'])).toEqual({index:3,length:4,suffix:['丁']})
    expect(index.match('history',['甲','乙','丙'])).toEqual({index:3,length:3,suffix:[]})
    expect(index.match('history',['甲','乙','丙','替换'])).toBeUndefined()
  })

  it('不同键彼此隔离，未知键不猜测共享数组',()=> {
    const index=prefixes()
    index.remember('history',2,['甲'])
    index.remember('generateData',9,['甲'])
    expect(index.match('other',['甲'])).toBeUndefined()
    expect(index.match('history',['甲','乙'])).toEqual({index:2,length:2,suffix:['乙']})
    expect(index.match('generateData',['甲','丙'])).toEqual({index:9,length:2,suffix:['丙']})
  })

  it('替换、中间插入与重新排序都拒绝复用，显式 remember 后才切换分叉',()=> {
    const index=prefixes()
    index.remember('history',1,['甲','乙','丙'])
    expect(index.match('history',['甲','替换','丙'])).toBeUndefined()
    expect(index.match('history',['甲','插入','乙','丙'])).toBeUndefined()
    expect(index.match('history',['乙','甲','丙'])).toBeUndefined()
    expect(index.match('history',['甲','乙','丙','丁'])).toEqual({index:1,length:4,suffix:['丁']})
    index.remember('history',8,['甲','新分支'])
    expect(index.match('history',['甲','新分支','后续'])).toEqual({index:8,length:3,suffix:['后续']})
    expect(index.match('history',['甲','乙'])).toBeUndefined()
  })

  it('对象键顺序参与指纹，同一对象原地修改也重新校验',()=> {
    const index=prefixes(),value={role:'user',content:'原文'}
    index.remember('history',4,[value])
    expect(index.match('history',[{content:'原文',role:'user'}])).toBeUndefined()
    value.content='改写'
    expect(index.match('history',[value])).toBeUndefined()
    expect(index.match('history',[{role:'user',content:'原文'}])).toEqual({index:4,length:1,suffix:[]})
  })

  it('不修改原数组或条目，返回的后缀外层数组可以独立追加',()=> {
    const index=prefixes(),first=Object.freeze({text:'甲'}),next=Object.freeze({text:'乙'})
    const initial=[first],incoming=[first,next]
    Object.freeze(initial);Object.freeze(incoming)
    index.remember('history',0,initial)
    const match=index.match('history',incoming)!
    expect(match.suffix).toEqual([next])
    expect(match.suffix[0]).toBe(next)
    match.suffix.push({text:'额外'})
    expect(initial).toEqual([first])
    expect(incoming).toEqual([first,next])
    expect(index.match('history',[first,next])).toEqual({index:0,length:2,suffix:[]})
  })

  it('首项不匹配便停止计算，指纹异常不发布不完整的新前缀',()=> {
    let calls=0,fail=false
    const index=new TemplateReplayArrayPrefixes(value=> {
      calls++
      if(fail && value==='异常') throw new Error('fingerprint failure')
      return fingerprint(value)
    })
    index.remember('history',5,['甲','乙'])
    calls=0
    expect(index.match('history',['替换','乙','丙'])).toBeUndefined()
    expect(calls).toBe(1)
    fail=true
    expect(()=>index.match('history',['甲','乙','丙','异常'])).toThrow('fingerprint failure')
    expect(()=>index.remember('history',99,['甲','异常'])).toThrow('fingerprint failure')
    expect(index.match('history',['甲','乙','丁'])).toEqual({index:5,length:3,suffix:['丁']})
  })
})
