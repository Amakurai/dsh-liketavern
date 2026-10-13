/** 运行时兼容登记回归：旧堆身份保持不变，ABI 不能自报放行，撤销优先于所有受支持版本。 */
import { describe, expect, it } from 'vitest'
import { resolveTemplateRuntimeIdentity, TEMPLATE_LEGACY_RUNTIME_ABIS, TEMPLATE_REVOKED_RUNTIME_HASHES,
  TEMPLATE_RUNTIME_ABI, type TemplateRuntimeCheckpointIdentity } from '../src/core/templateRuntimeAbi.js'

const legacyHash='77f29556bf365b33ddb9d006fc8ea78f6088c36fd3c464a0ef2c4c036dc0a3f1'
const currentHash='1'.repeat(64)
const unknownHash='2'.repeat(64)

describe('模板持久运行时 ABI',()=> {
  it('已登记的无 ABI 旧检查点自动归类，并保留创建它的指纹',()=> {
    const checkpoint={runtimeHash:legacyHash}
    const identity=resolveTemplateRuntimeIdentity(checkpoint,currentHash)
    expect(identity).toEqual({runtimeHash:legacyHash,runtimeAbi:TEMPLATE_RUNTIME_ABI})
    expect(checkpoint).toEqual({runtimeHash:legacyHash})
    expect(Object.isFrozen(identity)).toBe(true)
    expect(resolveTemplateRuntimeIdentity(identity,currentHash)).toEqual(identity)
  })

  it('接受受信本地当前版本，有无显式 ABI 都归类到同一契约',()=> {
    const expected={runtimeHash:currentHash,runtimeAbi:TEMPLATE_RUNTIME_ABI}
    expect(resolveTemplateRuntimeIdentity({runtimeHash:currentHash},currentHash)).toEqual(expected)
    expect(resolveTemplateRuntimeIdentity(expected,currentHash)).toEqual(expected)
  })

  it('未知指纹不能靠自报已支持 ABI 获得恢复权限',()=> {
    expect(()=>resolveTemplateRuntimeIdentity({runtimeHash:unknownHash},currentHash)).toThrow(/未知运行时指纹/)
    expect(()=>resolveTemplateRuntimeIdentity({runtimeHash:unknownHash,runtimeAbi:TEMPLATE_RUNTIME_ABI},currentHash)).toThrow(/未知运行时指纹/)
  })

  it.each([legacyHash,currentHash])('已知指纹 %s 显式声明错误 ABI 时仍拒绝',runtimeHash=> {
    for(const runtimeAbi of ['', 'dsh-tavern-template-runtime/v2', 'v1']) {
      expect(()=>resolveTemplateRuntimeIdentity({runtimeHash,runtimeAbi},currentHash)).toThrow(/ABI 不匹配/)
    }
  })

  it.each([legacyHash,currentHash])('撤销优先于已登记或当前指纹 %s',runtimeHash=> {
    const checkpoint={runtimeHash,runtimeAbi:TEMPLATE_RUNTIME_ABI}
    expect(()=>resolveTemplateRuntimeIdentity(checkpoint,currentHash,[runtimeHash])).toThrow(/已撤销/)
    expect(resolveTemplateRuntimeIdentity(checkpoint,currentHash,[unknownHash]).runtimeHash).toBe(runtimeHash)
  })

  it('额外撤销策略不能把未知版本登记为可恢复',()=> {
    expect(()=>resolveTemplateRuntimeIdentity({runtimeHash:unknownHash,runtimeAbi:TEMPLATE_RUNTIME_ABI},currentHash,[])).toThrow(/未知运行时指纹/)
    expect(()=>resolveTemplateRuntimeIdentity({runtimeHash:unknownHash},currentHash,[unknownHash])).toThrow(/已撤销/)
  })

  it('指纹必须为完整规范 SHA-256，当前版本参数也不能绕过格式验证',()=> {
    for(const runtimeHash of ['',currentHash.slice(1),'G'.repeat(64),`${currentHash}\n`]) {
      expect(()=>resolveTemplateRuntimeIdentity({runtimeHash},runtimeHash)).toThrow(/指纹无效/)
    }
    expect(()=>resolveTemplateRuntimeIdentity({runtimeHash:legacyHash},'')).toThrow(/指纹无效/)
    const malformed={runtimeHash:currentHash,runtimeAbi:null} as unknown as TemplateRuntimeCheckpointIdentity
    expect(()=>resolveTemplateRuntimeIdentity(malformed,currentHash)).toThrow(/ABI 不匹配/)
  })

  it('内置兼容和撤销登记不可被调用方修改，未虚构已撤销版本',()=> {
    expect(Object.isFrozen(TEMPLATE_LEGACY_RUNTIME_ABIS)).toBe(true)
    expect(Object.isFrozen(TEMPLATE_REVOKED_RUNTIME_HASHES)).toBe(true)
    expect(TEMPLATE_LEGACY_RUNTIME_ABIS[legacyHash]).toBe(TEMPLATE_RUNTIME_ABI)
    expect(TEMPLATE_REVOKED_RUNTIME_HASHES).toEqual([])
  })
})
