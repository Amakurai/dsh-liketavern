/**
 * 检查点宿主通信契约与受信版本登记；实现指纹保存旧堆语义，ABI 决定当前宿主是否能继续调用它。
 * v1 固定上下文/消息身份输入、阶段切换、异步 render 收口、变量/sticky/正则/出口/格式化输出的现有形状。
 * helper 或 vendor 的兼容更新无需改 ABI；改变上述命令契约须新增适配器与 ABI，不能重跑新 bootstrap 覆盖旧闭包。
 * 这里仅做元数据兼容判定，不认证存档，也不放宽独立的 WASM、句柄、内存或 worker 安全边界。
 */
export const TEMPLATE_RUNTIME_ABI = 'dsh-tavern-template-runtime/v1' as const
export type TemplateRuntimeAbi = typeof TEMPLATE_RUNTIME_ABI
export interface TemplateRuntimeIdentity {
  readonly runtimeHash:string
  readonly runtimeAbi:TemplateRuntimeAbi
}
export interface TemplateRuntimeCheckpointIdentity {
  readonly runtimeHash:string
  readonly runtimeAbi?:string
}

/** 已核对 v1 命令契约的旧运行时；后续发布须保留仍受支持的指纹，不能信任存档自报的 ABI。 */
export const TEMPLATE_LEGACY_RUNTIME_ABIS:Readonly<Record<string,TemplateRuntimeAbi>>=Object.freeze({
  // 同一已核对旧发布代码；两 vendor 的 Git 行尾组合依次为 LF/LF、CRLF/LF、LF/CRLF、CRLF/CRLF。
  // 仅保留逐字节推导的这四个 SHA，不能按存档自报 ABI 或任意规范化摘要登记未知实现。
  '77f29556bf365b33ddb9d006fc8ea78f6088c36fd3c464a0ef2c4c036dc0a3f1':TEMPLATE_RUNTIME_ABI,
  'c69564d6829235e24ac370e0ff5fe623fcdaa65f4ce667a03db1b4424e759178':TEMPLATE_RUNTIME_ABI,
  '983b21d0af3f482bb6021c66ed58990823bdac23a05c5a706eb6da8ae077bf60':TEMPLATE_RUNTIME_ABI,
  '5969cbc13c8beb5483d655aa10e5ae82a7f12f98b6133e7f4bde6bbec171a236':TEMPLATE_RUNTIME_ABI,
})

/** 仅登记确实需要禁止恢复的运行时；撤销优先于 current 和 legacy，不用虚构版本占位。 */
export const TEMPLATE_REVOKED_RUNTIME_HASHES:readonly string[]=Object.freeze([])

/**
 * currentHash 必须由本地受信 bootstrap/vendor 计算，不能取自存档。
 * additionalRevokedRuntimeHashes 只增加拒绝项，供受信调用方收紧策略；无法登记新的兼容版本或解除内置撤销。
 */
export function resolveTemplateRuntimeIdentity(
  checkpoint:TemplateRuntimeCheckpointIdentity,
  currentHash:string,
  additionalRevokedRuntimeHashes:readonly string[]=[],
):TemplateRuntimeIdentity {
  const hash=checkpoint.runtimeHash
  if(typeof hash!=='string'||hash.length!==64||!/^[0-9a-f]{64}$/.test(hash)
    ||typeof currentHash!=='string'||currentHash.length!==64||!/^[0-9a-f]{64}$/.test(currentHash)) {
    throw new Error('模板检查点运行时不兼容：运行时指纹无效')
  }
  if(TEMPLATE_REVOKED_RUNTIME_HASHES.includes(hash)||additionalRevokedRuntimeHashes.includes(hash)) {
    throw new Error('模板检查点运行时已撤销，拒绝恢复；请从兼容的较早楼层分支')
  }
  const knownAbi=hash===currentHash ? TEMPLATE_RUNTIME_ABI
    : Object.hasOwn(TEMPLATE_LEGACY_RUNTIME_ABIS,hash) ? TEMPLATE_LEGACY_RUNTIME_ABIS[hash] : undefined
  if(!knownAbi) throw new Error('模板检查点运行时不兼容：未知运行时指纹；请使用创建检查点的插件版本恢复，或从兼容的较早楼层分支')
  if(checkpoint.runtimeAbi!==undefined && checkpoint.runtimeAbi!==knownAbi) {
    throw new Error('模板检查点运行时不兼容：宿主通信 ABI 不匹配')
  }
  return Object.freeze({runtimeHash:hash,runtimeAbi:knownAbi})
}
