/** 关于与更新检查工厂测试：真实安装元数据、手写网络流、SemVer、固定地址、超时和失败边界，不访问真实网络。 */
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginAboutReader, getPluginAbout, readHostEntryMetadata, type PluginAboutMetadata } from '../src/node/pluginAbout.js'

const REPOSITORY = 'https://github.com/Amakurai/dsh-liketavern'
const API = 'https://api.github.com/repos/Amakurai/dsh-liketavern/releases/latest'
const HOST = '0.1.5-rc.2'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const pkg = (version = '0.2.5', host = HOST) => ({ name: 'dsh-liketavern', version, peerDependencies: { '@deepseek-ai/dsh': host } })
const metadata = (version = '0.2.5', host = HOST, sourceCheckout = false): PluginAboutMetadata => ({ plugin: pkg(version), host: { name: '@deepseek-ai/dsh', version: host }, sourceCheckout })
const release = (tag = 'v0.2.6') => ({ tag_name: tag, draft: false, prerelease: false, html_url: 'https://untrusted.example/ignored' })
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function factory(options: { current?: string; host?: string; sourceCheckout?: boolean; tag?: string; requiredHost?: string } = {}) {
  const tag = options.tag ?? 'v0.2.6'
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(response(release(tag)))
    .mockResolvedValueOnce(response(pkg(tag.replace(/^v/, ''), options.requiredHost ?? HOST)))
  const reader = createPluginAboutReader({ fetch, readMetadata: async () => metadata(options.current, options.host, options.sourceCheckout) })
  return { reader, fetch }
}

describe('关于元数据', () => {
  it('真实源码读取自身版本，但 Vitest 启动入口不能伪装成插件旁的开发宿主', async () => {
    const own = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; peerDependencies: Record<string, string> }
    const checkout = await lstat(fileURLToPath(new URL('../.git', import.meta.url))).then(() => true, () => false)
    const result = await getPluginAbout()
    expect(result).toEqual({ version: own.version, hostVersion: 'unknown', expectedHostVersion: own.peerDependencies['@deepseek-ai/dsh'],
      repositoryUrl: REPOSITORY, releasesUrl: `${REPOSITORY}/releases`, sourceCheckout: checkout })
    expect(JSON.stringify(result)).not.toContain(fileURLToPath(new URL('../', import.meta.url)))
  })
  it('初始化和读取关于信息不联网，只有显式检查才调用 fetch', async () => {
    const { reader, fetch } = factory()
    expect(fetch).not.toHaveBeenCalled()
    await reader.getPluginAbout(); await reader.getPluginAbout()
    expect(fetch).not.toHaveBeenCalled()
    await reader.checkPluginUpdate()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('本地元数据损坏或读取异常不泄露底层文件路径', async () => {
    const reader = createPluginAboutReader({ fetch: vi.fn(), readMetadata: async () => { throw Error('C:/private/config secret-token') } })
    await expect(reader.getPluginAbout()).rejects.toThrow('插件或宿主版本元数据无效')
    await expect(createPluginAboutReader({ readMetadata: async () => ({ ...metadata(), plugin: pkg('01.2.3') }) }).getPluginAbout()).rejects.toThrow('版本元数据无效')
  })
  it('无法确认运行宿主时关于页仍可读，更新检查明确拒绝且不联网', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const reader = createPluginAboutReader({ fetch, readMetadata: async () => ({ ...metadata(), host: null }) })
    expect(await reader.getPluginAbout()).toMatchObject({ version: '0.2.5', hostVersion: 'unknown', expectedHostVersion: HOST })
    await expect(reader.checkPluginUpdate()).rejects.toThrow('无法确认当前运行宿主版本')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('以实际全局/本地入口选择两个不同版本，目录 junction 先解析真实入口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-host-entry-')); roots.push(root)
    const global = join(root, 'global/node_modules/@deepseek-ai/dsh'), local = join(root, 'project/node_modules/@deepseek-ai/dsh')
    for (const [directory, version] of [[global, '0.1.5-rc.2'], [local, '9.8.7']] as const) {
      await mkdir(join(directory, 'lib'), { recursive: true })
      await writeFile(join(directory, 'lib/bin.js'), '// synthetic host entry')
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
    }
    expect(await readHostEntryMetadata(join(global, 'lib/bin.js'))).toMatchObject({ version: '0.1.5-rc.2' })
    expect(await readHostEntryMetadata(join(local, 'lib/bin.js'))).toMatchObject({ version: '9.8.7' })
    const linked = join(root, 'linked-global'); await symlink(global, linked, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await readHostEntryMetadata(join(linked, 'lib/bin.js'))).toMatchObject({ version: '0.1.5-rc.2' })
    const reader = createPluginAboutReader({ readMetadata: async () => ({ ...metadata(), host: await readHostEntryMetadata(join(global, 'lib/bin.js')) }) })
    expect((await reader.getPluginAbout()).hostVersion).toBe('0.1.5-rc.2')
  })
  it('自定义 launcher、错误 bin 身份及缺失入口不能回退到另一个已安装宿主', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-host-entry-')); roots.push(root)
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'lib/bin.js'), '// custom launcher')
    await writeFile(join(root, 'lib/other.js'), '// declared entry')
    const path = join(root, 'package.json'), entry = join(root, 'lib/bin.js')
    await writeFile(path, JSON.stringify({ name: 'custom-launcher', version: '1.0.0', bin: { dsh: 'lib/bin.js' } }))
    expect(await readHostEntryMetadata(entry)).toBeNull()
    await writeFile(path, JSON.stringify({ name: '@deepseek-ai/dsh', version: HOST, bin: { dsh: 'lib/other.js' } }))
    expect(await readHostEntryMetadata(entry)).toBeNull()
    await writeFile(path, JSON.stringify({ name: '@deepseek-ai/dsh', version: 'invalid', bin: { dsh: 'lib/bin.js' } }))
    expect(await readHostEntryMetadata(entry)).toBeNull()
    expect(await readHostEntryMetadata(join(root, 'missing.js'))).toBeNull()
    expect(await readHostEntryMetadata(undefined)).toBeNull()
  })
})

describe('明确且有界的更新检查', () => {
  it('固定域名、拒绝重定向，忽略发布者输入的跳转链接，只生成明确 web 安装命令', async () => {
    const { reader, fetch } = factory()
    expect(await reader.checkPluginUpdate()).toEqual({ status: 'available', latestVersion: '0.2.6', requiredHostVersion: HOST,
      releaseUrl: `${REPOSITORY}/releases/tag/v0.2.6`, command: 'dsh plugin --profile web add github:Amakurai/dsh-liketavern#v0.2.6' })
    expect(fetch.mock.calls.map(call => call[0])).toEqual([API, 'https://raw.githubusercontent.com/Amakurai/dsh-liketavern/v0.2.6/package.json'])
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', signal: expect.any(AbortSignal) })
  })
  it.each([
    ['0.2.5', '0.2.5', 'current'], ['0.2.5+local.1', 'v0.2.5+release.2', 'current'],
    ['0.2.9', 'v0.2.10', 'available'], ['0.2.10', 'v0.2.9', 'ahead'], ['0.2.6-rc.10', 'v0.2.6', 'available'],
    ['0.2.7-alpha.1', 'v0.2.6', 'ahead'], ['9007199254740992.0.0', 'v9007199254740993.0.0', 'available'],
  ])('SemVer 比较 %s 与 %s 得到 %s', async (current, tag, status) => {
    const { reader } = factory({ current, tag })
    const result = await reader.checkPluginUpdate()
    expect(result.status).toBe(status)
    expect(result.command !== null).toBe(status === 'available')
  })
  it('宿主必须满足目标精确 peer，build metadata 不影响匹配', async () => {
    expect(await factory({ host: '0.1.5-rc.10' }).reader.checkPluginUpdate()).toMatchObject({ status: 'incompatible', command: null, requiredHostVersion: HOST })
    expect(await factory({ host: `${HOST}+local`, requiredHost: `${HOST}+release` }).reader.checkPluginUpdate()).toMatchObject({ status: 'available', command: expect.any(String) })
  })
  it('源码检出仍报告可用版本但绝不给出覆盖开发挂载的安装命令', async () => {
    const { reader } = factory({ sourceCheckout: true })
    expect((await reader.getPluginAbout()).sourceCheckout).toBe(true)
    expect(await reader.checkPluginUpdate()).toMatchObject({ status: 'available', command: null })
  })
  it('同时多次点击共用一轮请求，完成后可以重新检查', async () => {
    let resolveRelease!: (value: Response) => void
    const waiting = new Promise<Response>(resolve => { resolveRelease = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(waiting).mockResolvedValueOnce(response(pkg('0.2.6')))
      .mockResolvedValueOnce(response(release())).mockResolvedValueOnce(response(pkg('0.2.6')))
    const reader = createPluginAboutReader({ fetch, readMetadata: async () => metadata() })
    const first = reader.checkPluginUpdate(), second = reader.checkPluginUpdate()
    expect(first).toBe(second)
    resolveRelease(response(release()))
    expect(await first).toEqual(await second)
    expect(fetch).toHaveBeenCalledTimes(2)
    await reader.checkPluginUpdate(); expect(fetch).toHaveBeenCalledTimes(4)
  })
})

describe('不可信远端信息与网络故障', () => {
  it.each(['../outside', 'v0.2.6;echo-secret', 'https://evil.test', 'v01.2.3', 'v1.2.3-rc.01', 'v1.2.3-rc.1', 'vv1.2.3'])('拒绝非法或非正式标签 %s', async tag => {
    const { reader, fetch } = factory({ tag })
    await expect(reader.checkPluginUpdate()).rejects.toThrow('发布元数据无效')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([{ draft: true }, { prerelease: true }, { draft: undefined }, { tag_name: 42 }])('拒绝非正式发布标志 %j', async patch => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...release(), ...patch }))
    await expect(createPluginAboutReader({ fetch, readMetadata: async () => metadata() }).checkPluginUpdate()).rejects.toThrow('发布元数据无效')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...pkg('0.2.6'), name: 'another-package' }, pkg('0.2.7'), pkg('0.2.6', '^0.1.5-rc.2'), pkg('0.2.6', '0.1.5-rc.02'),
    { name: 'dsh-liketavern', version: '0.2.6' },
  ])('目标 tag 的 package 身份/版本/peer 必须准确 %j', async target => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response(release())).mockResolvedValueOnce(response(target))
    await expect(createPluginAboutReader({ fetch, readMetadata: async () => metadata() }).checkPluginUpdate()).rejects.toThrow('发布元数据无效')
  })
  it.each([[404, /尚无可用正式发布/], [429, /过于频繁/], [500, /无法读取/], [302, /无法读取/]] as const)('HTTP %i 返回明确失败', async (status, message) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('private server body', { status }))
    await expect(createPluginAboutReader({ fetch, readMetadata: async () => metadata() }).checkPluginUpdate()).rejects.toThrow(message)
  })
  it('网络与流错误使用固定错误文案，失败后允许重试', async () => {
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(Error('private-token in stream')) } })
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(Error('private-token in network'))
      .mockResolvedValueOnce(new Response(broken)).mockResolvedValueOnce(response(release())).mockResolvedValueOnce(response(pkg('0.2.6')))
    const reader = createPluginAboutReader({ fetch, readMetadata: async () => metadata() })
    await expect(reader.checkPluginUpdate()).rejects.toThrow('无法读取 GitHub 更新信息，请稍后重试')
    await expect(reader.checkPluginUpdate()).rejects.toThrow('无法读取 GitHub 更新信息，请稍后重试')
    expect((await reader.checkPluginUpdate()).status).toBe('available')
  })
  it('非 JSON 和伪造重定向响应明确拒绝', async () => {
    const invalid = new Response('{private invalid data')
    const redirected = response(release()); Object.defineProperty(redirected, 'redirected', { value: true })
    for (const result of [invalid, redirected]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(result)
      await expect(createPluginAboutReader({ fetch, readMetadata: async () => metadata() }).checkPluginUpdate()).rejects.toThrow()
    }
  })
  it('无可信 content-length 的流仍按字节限额，超过 256 KiB 取消读取', async () => {
    const cancelled = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(70_000)) }, cancel: cancelled })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(stream))
    await expect(createPluginAboutReader({ fetch, readMetadata: async () => metadata() }).checkPluginUpdate()).rejects.toThrow('256 KiB')
    expect(cancelled).toHaveBeenCalled()
    const header = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('small body', { headers: { 'content-length': '262145' } }))
    await expect(createPluginAboutReader({ fetch: header, readMetadata: async () => metadata() }).checkPluginUpdate()).rejects.toThrow('256 KiB')
  })
  it('分块 UTF-8 JSON 可以正常解析，两个请求共用同一超时 signal', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ ...release(), body: '发布说明' }))
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(stream)).mockResolvedValueOnce(response(pkg('0.2.6')))
    expect((await createPluginAboutReader({ fetch, readMetadata: async () => metadata() }).checkPluginUpdate()).status).toBe('available')
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(fetch.mock.calls[1]?.[1]?.signal)
  })
  it('fetch 永久挂起也受总期限约束并发送 abort', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise<Response>(() => {}))
    await expect(createPluginAboutReader({ fetch, readMetadata: async () => metadata(), timeoutMs: 15 }).checkPluginUpdate()).rejects.toThrow('超时')
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
  it('响应正文挂起同样超时并取消流，不能仅给请求头阶段设置期限', async () => {
    const cancelled = vi.fn()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })))
    await expect(createPluginAboutReader({ fetch, readMetadata: async () => metadata(), timeoutMs: 15 }).checkPluginUpdate()).rejects.toThrow('超时')
    expect(cancelled).toHaveBeenCalled()
  })
})
