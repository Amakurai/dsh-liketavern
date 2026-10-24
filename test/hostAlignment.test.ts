/** 宿主版本对齐脚本：真实仓库必须通过，peer / dev / overrides / allowScripts / 锁文件任一漂移都必须被点名拒绝。 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { inspectHostAlignment } from '../scripts/verify-host-alignment.mjs'

const readJson = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')) as Record<string, any>

function fixture() {
  return {
    pkg: {
      version: '0.5.7',
      peerDependencies: { '@deepseek-ai/dsh': '0.2.1-rc.3', '@deepseek-ai/cordis': '4.0.5' },
      devDependencies: { '@deepseek-ai/dsh-agent': '0.2.1-rc.3' },
      overrides: { '@deepseek-ai/dsh-llm': '0.2.1-rc.3' },
      allowScripts: { '@deepseek-ai/dsh-subprocess-local@0.2.1-rc.3': true, esbuild: true },
    },
    lock: {
      packages: {
        '': { version: '0.5.7' },
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
  expect(result.baseline).toBe(readJson('package.json').peerDependencies['@deepseek-ai/dsh'])
  expect(result.packages).toBeGreaterThan(20)
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
