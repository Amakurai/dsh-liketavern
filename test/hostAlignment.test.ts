/** 宿主版本对齐脚本：真实仓库必须通过，peer / dev / overrides / allowScripts / 锁文件任一漂移都必须被点名拒绝。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'
import { satisfies } from 'semver'
import { hostVersionSatisfies, manifestHostRange } from '../src/core/hostVersion.js'
import { inspectHostAlignment } from '../scripts/verify-host-alignment.mjs'

const readJson = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')) as Record<string, any>

function fixture() {
  return {
    pkg: {
      version: '0.5.7',
      peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-rc.3 <0.3.0-0', '@deepseek-ai/cordis': '4.0.5' },
      devDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.3', '@deepseek-ai/dsh-agent': '0.2.1-rc.3' },
      overrides: { '@deepseek-ai/dsh-llm': '0.2.1-rc.3' },
      allowScripts: { '@deepseek-ai/dsh-subprocess-local@0.2.1-rc.3': true, esbuild: true },
    },
    lock: {
      packages: {
        '': { version: '0.5.7', peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-rc.3 <0.3.0-0', '@deepseek-ai/cordis': '4.0.5' } },
        'node_modules/@deepseek-ai/dsh': { version: '0.2.1-rc.3' },
        'node_modules/@deepseek-ai/dsh-agent': { version: '0.2.1-rc.3' },
        'node_modules/@deepseek-ai/dsh-llm': { version: '0.2.1-rc.3' },
        'node_modules/@deepseek-ai/cordis': { version: '4.0.5' },
      },
    },
  }
}

it('当前仓库的宿主依赖与锁文件全部对齐', () => {
  const result = inspectHostAlignment(readJson('package.json'), readJson('package-lock.json'))
  expect(result.errors).toEqual([])
  expect(result.baseline).toBe(readJson('package.json').devDependencies['@deepseek-ai/dsh'])
  expect(result.packages).toBeGreaterThan(20)
})

it.each(['0.2.0-alpha.1', '0.2.0-rc.1', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-alpha.2', '0.2.9-alpha.1', '0.3.9-alpha.1', '0.4.0-alpha.1', '0.4.0'])
('诊断判断与真实宿主插件加载器一致：%s', version => {
  const manifest = readJson('package.json')
  expect(hostVersionSatisfies(version, manifestHostRange(manifest)))
    .toBe(evaluatePluginCompatibility(manifest, {}, version) === undefined)
})

it('包管理器也接受近期各 0.2 和 0.3 补丁线的预发布版本', () => {
  const manifest = readJson('package.json'), range = manifest.peerDependencies['@deepseek-ai/dsh'] as string
  for (const version of ['0.2.0-rc.1', '0.2.1-alpha.1', '0.2.2-alpha.2', '0.2.9-rc.1', '0.3.0-alpha.1', '0.3.9-rc.1']) {
    expect(satisfies(version, range), version).toBe(true)
  }
  expect(satisfies('0.4.0-alpha.1', range)).toBe(false)
  for (const version of ['4.0.4', '4.0.5-alpha.1', '4.0.6-alpha.1', '4.0.9-rc.1']) {
    expect(satisfies(version, manifest.peerDependencies['@deepseek-ai/cordis']), version).toBe(true)
  }
  for (const version of ['3.18.4', '3.18.5-alpha.1', '3.18.6-alpha.1', '3.18.9-rc.1']) {
    expect(satisfies(version, manifest.peerDependencies['@deepseek-ai/schemastery']), version).toBe(true)
  }
})

it('显式 engines.dsh 按宿主语义优先，旧清单继续使用 peer', () => {
  expect(manifestHostRange({ engines: { dsh: '>=0.2.0 <0.4.0' }, peerDependencies: { '@deepseek-ai/dsh': '0.1.0' } })).toBe('>=0.2.0 <0.4.0')
  expect(manifestHostRange({ engines: { node: '>=24' }, peerDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.3' } })).toBe('0.2.1-rc.3')
  expect(manifestHostRange({ engines: { dsh: 'not-a-range' }, peerDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.3' } })).toBe('unknown')
})

it('依赖表、allowScripts 与锁文件一致时通过', () => {
  const { pkg, lock } = fixture()
  expect(inspectHostAlignment(pkg, lock)).toMatchObject({ baseline: '0.2.1-rc.3', errors: [] })
})

it.each([
  ['devDependencies 漏改', (pkg: any) => { pkg.devDependencies['@deepseek-ai/dsh-agent'] = '0.2.1-rc.2' }, /不一致/g],
  ['overrides 漏改', (pkg: any) => { pkg.overrides['@deepseek-ai/dsh-llm'] = '0.2.1-rc.2' }, /不一致/g],
  ['范围版本掩盖升级', (pkg: any) => { pkg.devDependencies['@deepseek-ai/dsh-agent'] = '^0.2.1-rc.3' }, /不是精确版本/],
  ['allowScripts 留旧版本', (pkg: any) => { pkg.allowScripts = { '@deepseek-ai/dsh-subprocess-local@0.2.1-rc.2': true } }, /allowScripts 仍记录/],
  ['缺少宿主 peer', (pkg: any) => { delete pkg.peerDependencies['@deepseek-ai/dsh'] }, /缺少有效的 @deepseek-ai\/dsh/],
  ['peer 范围不包含基线', (pkg: any) => { pkg.peerDependencies['@deepseek-ai/dsh'] = '>=0.2.2' }, /不包含宿主基线/],
  ['peer 范围不能越过兼容上限', (pkg: any) => { pkg.peerDependencies['@deepseek-ai/dsh'] = '*' }, /peer 范围越界/],
  ['engines 与 peer 不一致', (pkg: any) => { pkg.engines = { dsh: '>=0.2.1-rc.3 <0.4.0-0' } }, /engines.dsh 与宿主 peer/],
  ['Cordis peer 不能越过主版本', (pkg: any) => { pkg.peerDependencies['@deepseek-ai/cordis'] = '*' }, /cordis.*peer 范围无效或越界/],
])('%s 会被拒绝', (_label, mutate, message) => {
  const { pkg, lock } = fixture()
  mutate(pkg)
  expect(inspectHostAlignment(pkg, lock).errors.join('\n')).toMatch(message)
})

it.each([
  ['锁文件里的宿主包仍是旧版本', (lock: any) => { lock.packages['node_modules/@deepseek-ai/dsh-agent'].version = '0.2.1-rc.2' }, /锁文件 @deepseek-ai\/dsh-agent 为 0\.2\.1-rc\.2/],
  ['锁文件缺少依赖表里的宿主包', (lock: any) => { delete lock.packages['node_modules/@deepseek-ai/dsh-llm'] }, /锁文件缺少 @deepseek-ai\/dsh-llm/],
  ['锁文件根版本落后', (lock: any) => { lock.packages[''].version = '0.5.6' }, /锁文件根版本 0\.5\.6/],
])('%s 会被拒绝', (_label, mutate, message) => {
  const { pkg, lock } = fixture()
  mutate(lock)
  expect(inspectHostAlignment(pkg, lock).errors.join('\n')).toMatch(message)
})
