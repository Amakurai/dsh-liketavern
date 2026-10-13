/** 重放数组的严格前缀索引：按调用方提供的 JSON 指纹复用只增历史，不改动入参或跨键共享可变状态。 */
export interface TemplateReplayArrayPrefixMatch {
  index:number
  length:number
  suffix:unknown[]
}

interface ArrayPrefix {
  index:number
  fingerprints:string[]
}

export class TemplateReplayArrayPrefixes {
  private readonly prefixes=new Map<string,ArrayPrefix>()
  private readonly fingerprint:(value:unknown)=>string

  /** 指纹必须反映实际 JSON 字节，包括对象键顺序；不能按对象身份缓存可变入参。 */
  constructor(fingerprint:(value:unknown)=>string) {
    this.fingerprint=fingerprint
  }

  /** 检查点已包含旧入参，后续日志重新建立仅覆盖尾部的共享索引。 */
  clear():void {this.prefixes.clear()}

  remember(key:string,index:number,values:unknown[]):void {
    const fingerprints=values.map(value=>this.fingerprint(value))
    this.prefixes.set(key,{index,fingerprints})
  }

  match(key:string,values:unknown[]):TemplateReplayArrayPrefixMatch|undefined {
    const current=this.prefixes.get(key)
    if(!current) return undefined
    const fingerprints:string[]=[]
    for(let index=0;index<values.length;index++) {
      const fingerprint=this.fingerprint(values[index])
      if(index<current.fingerprints.length && current.fingerprints[index]!==fingerprint) return undefined
      fingerprints.push(fingerprint)
    }
    const suffix=values.slice(current.fingerprints.length)
    // 先完成全部指纹计算再更新；短前缀保留最长序列，异常或分叉不改变后续匹配结果。
    if(fingerprints.length>current.fingerprints.length) current.fingerprints=fingerprints
    return {index:current.index,length:values.length,suffix}
  }
}
