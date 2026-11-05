/** 宿主版本策略：公开门槛完全放开（任意过去/未来版本都接受），开发基线仍固定精确并受锁文件约束。 */
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
      version: '0.5.9',
      engines: { node: '>=24', dsh: '*' },
      peerDependencies: { '@deepseek-ai/dsh': '*', '@deepseek-ai/dsh-agent': '*', '@deepseek-ai/cordis': '*' },
      devDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.3', '@deepseek-ai/dsh-agent': '0.2.1-rc.3' },
      overrides: { '@deepseek-ai/dsh-llm': '0.2.1-rc.3' },
      allowScripts: { '@deepseek-ai/dsh-subprocess-local@0.2.1-rc.3': true, esbuild: true },
    },
    lock: {
      packages: {
        '': {
          version: '0.5.9',
          engines: { node: '>=24', dsh: '*' },
          peerDependencies: { '@deepseek-ai/dsh': '*', '@deepseek-ai/dsh-agent': '*', '@deepseek-ai/cordis': '*' },
        },
        'node_modules/@deepseek-ai/dsh': { version: '0.2.1-rc.3' },
        'node_modules/@deepseek-ai/dsh-agent': { version: '0.2.1-rc.3' },
        'node_modules/@deepseek-ai/dsh-llm': { version: '0.2.1-rc.3' },
        'node_modules/@deepseek-ai/cordis': { version: '4.0.5' },
      },
    },
  }
}

/** 从过去的 alpha 到未来的大版本：宿主加载器都必须接受这份清单。 */
const HOST_VERSIONS = ['0.1.0', '0.2.0-alpha.1', '0.2.0-rc.1', '0.2.1-rc.3', '0.2.1-rc.5',
  '0.2.2-alpha.2', '0.2.9-rc.1', '0.3.0', '0.3.9', '0.4.0-alpha.1', '0.4.0', '1.0.0', '2.5.3-rc.1']

it('当前仓库的宿主依赖、公开门槛与锁文件全部对齐', () => {
  const result = inspectHostAlignment(readJson('package.json'), readJson('package-lock.json'))
  expect(result.errors).toEqual([])
  expect(result.baseline).toBe(readJson('package.json').devDependencies['@deepseek-ai/dsh'])
  expect(result.packages).toBeGreaterThan(20)
})

it('真实宿主加载器接受任意版本：过去与未来的自动升级都不会把插件判为不兼容', () => {
  const manifest = readJson('package.json')
  for (const version of HOST_VERSIONS) {
    expect(hostVersionSatisfies(version, manifestHostRange(manifest)), version).toBe(true)
    expect(evaluatePluginCompatibility(manifest, {}, version), version).toBeUndefined()
  }
})

it('公开门槛放开后诊断判断与真实宿主插件加载器仍逐版本一致', () => {
  const manifest = readJson('package.json')
  for (const version of HOST_VERSIONS) {
    expect(hostVersionSatisfies(version, manifestHostRange(manifest)))
      .toBe(evaluatePluginCompatibility(manifest, {}, version) === undefined)
  }
})

it('公开 peer 与 engines.dsh 都是开放的 *，包管理器不再按宿主版本报警', () => {
  const manifest = readJson('package.json')
  expect(manifest.engines.dsh).toBe('*')
  for (const [name, spec] of Object.entries(manifest.peerDependencies as Record<string, string>)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    expect(spec, name).toBe('*')
    for (const version of ['0.1.0', '0.2.1-rc.5', '0.4.0', '1.0.0']) {
      // 宿主加载器（0.2.0-rc.1 起的每一代）都以 includePrerelease 语义判断，预发布宿主同样被接受。
      expect(satisfies(version, spec, { includePrerelease: true }), `${name} ${version}`).toBe(true)
    }
  }
  expect(manifest.peerDependencies['@deepseek-ai/dsh']).toBe('*')
})

it('显式 engines.dsh 按宿主语义优先，旧清单继续使用 peer', () => {
  expect(manifestHostRange({ engines: { dsh: '*' }, peerDependencies: { '@deepseek-ai/dsh': '0.1.0' } })).toBe('*')
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
  ['缺少宿主 peer', (pkg: any) => { delete pkg.peerDependencies['@deepseek-ai/dsh'] }, /缺少 @deepseek-ai\/dsh/],
  ['peer 被重新钉版本', (pkg: any) => { pkg.peerDependencies['@deepseek-ai/dsh'] = '>=0.2.1-rc.3 <0.3.0-0' }, /应放开为 \*/],
  ['其它宿主 peer 被重新钉版本', (pkg: any) => { pkg.peerDependencies['@deepseek-ai/dsh-agent'] = '0.2.1-rc.3' }, /应放开为 \*/],
  ['cordis peer 被重新钉版本', (pkg: any) => { pkg.peerDependencies['@deepseek-ai/cordis'] = '4.0.5' }, /应放开为 \*/],
  ['engines.dsh 被重新设上限', (pkg: any) => { pkg.engines = { dsh: '>=0.2.1-rc.3 <0.4.0-0' } }, /应放开为 \*/],
  ['engines.dsh 缺失', (pkg: any) => { pkg.engines = { node: '>=24' } }, /engines\.dsh 缺失/],
])('%s 会被拒绝', (_label, mutate, message) => {
  const { pkg, lock } = fixture()
  mutate(pkg)
  expect(inspectHostAlignment(pkg, lock).errors.join('\n')).toMatch(message)
})

it.each([
  ['锁文件里的宿主包仍是旧版本', (lock: any) => { lock.packages['node_modules/@deepseek-ai/dsh-agent'].version = '0.2.1-rc.2' }, /锁文件 @deepseek-ai\/dsh-agent 为 0\.2\.1-rc\.2/],
  ['锁文件缺少依赖表里的宿主包', (lock: any) => { delete lock.packages['node_modules/@deepseek-ai/dsh-llm'] }, /锁文件缺少 @deepseek-ai\/dsh-llm/],
  ['锁文件根版本落后', (lock: any) => { lock.packages[''].version = '0.5.8' }, /锁文件根版本 0\.5\.8/],
  ['锁文件仍记录旧的 engines.dsh', (lock: any) => { lock.packages[''].engines = { dsh: '>=0.2.0-rc.1 <0.4.0-0' } }, /锁文件的 engines\.dsh 与清单不一致/],
])('%s 会被拒绝', (_label, mutate, message) => {
  const { pkg, lock } = fixture()
  mutate(lock)
  expect(inspectHostAlignment(pkg, lock).errors.join('\n')).toMatch(message)
})
