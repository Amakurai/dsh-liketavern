/** 运行时指纹的跨平台换行兼容；受信构建代码的 LF/CRLF 等价，不降低未知旧指纹或 ABI 的拒绝边界。 */
import { createHash } from 'node:crypto'
import { expect,it } from 'vitest'
import { fingerprintTemplateRuntime,loadTemplateRuntime } from '../src/node/templateRuntime.js'
import { BOOTSTRAP } from '../src/node/templateBootstrap.js'
import { resolveTemplateRuntimeIdentity,TEMPLATE_RUNTIME_ABI } from '../src/core/templateRuntimeAbi.js'

const legacyHashes=[
  '77f29556bf365b33ddb9d006fc8ea78f6088c36fd3c464a0ef2c4c036dc0a3f1',
  'c69564d6829235e24ac370e0ff5fe623fcdaa65f4ce667a03db1b4424e759178',
  '983b21d0af3f482bb6021c66ed58990823bdac23a05c5a706eb6da8ae077bf60',
  '5969cbc13c8beb5483d655aa10e5ae82a7f12f98b6133e7f4bde6bbec171a236',
]
const lines=(source:string,crlf:boolean)=>source.replaceAll('\r\n','\n').replaceAll('\n',crlf?'\r\n':'\n')
const rawHash=(bootstrap:string,libraries:string,faker:string)=>createHash('sha256').update(bootstrap).update('\0').update(libraries).update('\0').update(faker).digest('hex')

it('两份真实发布 vendor 的四种 Git 换行组合产生同一当前指纹，实际代码改动仍改变指纹',async()=> {
  const {librarySource,fakerSource,hash}=await loadTemplateRuntime()
  const libraries=lines(librarySource,false),faker=lines(fakerSource,false)
  expect(libraries).toContain('\n');expect(faker).toContain('\n')
  expect(hash).toBe(rawHash(BOOTSTRAP,libraries,faker))
  for(let variant=0;variant<4;variant++) {
    expect(fingerprintTemplateRuntime(BOOTSTRAP,lines(libraries,Boolean(variant&1)),lines(faker,Boolean(variant&2)))).toBe(hash)
  }
  expect(fingerprintTemplateRuntime(BOOTSTRAP,libraries+';globalThis.changed=true;',faker)).not.toBe(hash)
  expect(fingerprintTemplateRuntime(BOOTSTRAP+';globalThis.changed=true;',libraries,faker)).not.toBe(hash)
})

it.each(legacyHashes)('已核对旧换行指纹 %s 恢复后仍保留原身份，不能偷偷重写成规范化版本',runtimeHash=> {
  const current='1'.repeat(64)
  expect(resolveTemplateRuntimeIdentity({runtimeHash},current)).toEqual({runtimeHash,runtimeAbi:TEMPLATE_RUNTIME_ABI})
  expect(()=>resolveTemplateRuntimeIdentity({runtimeHash,runtimeAbi:'unknown-abi'},current)).toThrow(/ABI 不匹配/)
})

it('v0.5.3–v0.5.6 的检查点在模板依赖安全升级后仍按原指纹恢复，且不等同当前版本',async()=> {
  const {hash}=await loadTemplateRuntime()
  for(const released of [
    '47c22ed5bb3551a8e6c5ab766fd66f2d009a9004033a4058d64e3fcd07f703cb',
    'daccaaf41aeb4f613f97ca128307110a98fa22e5f17a4bfd39bb9f515175a75c',
  ]) {
    expect(hash).not.toBe(released)
    expect(resolveTemplateRuntimeIdentity({runtimeHash:released},hash)).toEqual({runtimeHash:released,runtimeAbi:TEMPLATE_RUNTIME_ABI})
    expect(resolveTemplateRuntimeIdentity({runtimeHash:released,runtimeAbi:TEMPLATE_RUNTIME_ABI},hash).runtimeHash).toBe(released)
  }
})
it('v0.5.3–v0.5.5 的检查点在 markdown-it 安全升级后仍按原指纹恢复，且不等同当前版本',async()=> {
  const released='47c22ed5bb3551a8e6c5ab766fd66f2d009a9004033a4058d64e3fcd07f703cb'
  const {hash}=await loadTemplateRuntime()
  expect(hash).not.toBe(released)
  expect(resolveTemplateRuntimeIdentity({runtimeHash:released},hash)).toEqual({runtimeHash:released,runtimeAbi:TEMPLATE_RUNTIME_ABI})
  expect(resolveTemplateRuntimeIdentity({runtimeHash:released,runtimeAbi:TEMPLATE_RUNTIME_ABI},hash).runtimeHash).toBe(released)
})

it('换行兼容不能让未登记的旧实现借自报 ABI 放行',()=> {
  const current='1'.repeat(64),runtimeHash='2'.repeat(64)
  expect(()=>resolveTemplateRuntimeIdentity({runtimeHash,runtimeAbi:TEMPLATE_RUNTIME_ABI},current)).toThrow(/未知运行时指纹/)
})
