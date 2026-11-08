/** 依赖声明回归：源码、测试与构建脚本不依赖偶然提升的包，服务端产物不能使用仅开发安装的依赖。 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { inspectDependencyDeclarations, packageReferences, projectReferences } from '../scripts/verify-dependencies.mjs'

it('当前全部直接引用都在依赖表声明', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(inspectDependencyDeclarations(pkg, projectReferences())).toEqual([])
})

it('缺失的子路径导入与 CommonJS 解析依赖均会被检出', () => {
  const references = packageReferences(`
    import type { Session } from '@factory/host/types';
    export { value } from 'missing-export/subpath';
    const first = await import('missing-dynamic/subpath');
    const second = require('missing-require');
    const third = require.resolve('missing-resolve/package.json');
    const fourth = import.meta.resolve('missing-meta/package.json');
    import 'node:fs'; import 'fs'; import './local.js';
  `, 'test/fixture.ts')
  expect(inspectDependencyDeclarations({}, references)).toEqual([
    'test/fixture.ts 直接使用 @factory/host，但依赖表未声明',
    'test/fixture.ts 直接使用 missing-export，但依赖表未声明',
    'test/fixture.ts 直接使用 missing-dynamic，但依赖表未声明',
    'test/fixture.ts 直接使用 missing-require，但依赖表未声明',
    'test/fixture.ts 直接使用 missing-resolve，但依赖表未声明',
    'test/fixture.ts 直接使用 missing-meta，但依赖表未声明',
  ])
})

it('类型、客户端与开发脚本允许开发依赖，服务端值导入必须有运行声明', () => {
  const pkg = { devDependencies: { '@factory/host': '1.0.0' } }
  const source = `
    import type {} from '@factory/host';
    import { type Session } from '@factory/host/types';
    export { type Session } from '@factory/host/types';
  `
  expect(inspectDependencyDeclarations(pkg, packageReferences(source, 'src/example.ts'))).toEqual([])
  const runtime = `import Host, { type Session } from '@factory/host';`
  for (const file of ['src/client/example.tsx', 'test/example.test.ts', 'scripts/example.mjs']) {
    expect(inspectDependencyDeclarations(pkg, packageReferences(runtime, file))).toEqual([])
  }
  const references = packageReferences(runtime, 'src/example.ts')
  expect(inspectDependencyDeclarations(pkg, references)).toEqual([
    'src/example.ts 运行时使用 @factory/host，但只声明了 devDependencies',
  ])
  expect(inspectDependencyDeclarations({ ...pkg, peerDependencies: { '@factory/host': '*' } }, references)).toEqual([])
})
