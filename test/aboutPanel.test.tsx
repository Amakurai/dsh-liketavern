/** 关于页真实 React 交互回归：按需检查、复制失败恢复，以及切换连接和卸载后的异步结果隔离。 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { AboutSection } from '../src/client/panel/about.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import type { PluginAbout, PluginUpdate } from '../src/node/pluginAbout.js'

/** 只替换宿主 primitives；AboutSection、共享读取 Hook、按钮和 Toast 状态均运行真实实现。 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Toast: (props: { text: string }) => <div data-toast>{props.text}</div>,
  Modal: () => null, Menu: () => null, Tooltip: () => null,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

const PROJECT = 'https://github.com/Amakurai/dsh-liketavern'
const COMMAND = 'dsh plugin --profile web add github:Amakurai/dsh-liketavern#v0.2.6'
const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (message: string) => ({ ok: false as const, error: { code: 'test', message } })
const about = (change: Partial<PluginAbout> = {}): PluginAbout => ({
  version: '0.2.5', hostVersion: '0.1.5-rc.2', expectedHostVersion: '0.1.5-rc.2',
  repositoryUrl: PROJECT, releasesUrl: `${PROJECT}/releases`, sourceCheckout: false, ...change,
})
const update = (change: Partial<PluginUpdate> = {}): PluginUpdate => ({
  status: 'available', latestVersion: '0.2.6', requiredHostVersion: '0.1.5-rc.2',
  releaseUrl: `${PROJECT}/releases/tag/v0.2.6`, command: COMMAND, ...change,
})
function fixture(metadata = about()) {
  const getPluginAbout = vi.fn<TavernRemote['getPluginAbout']>().mockResolvedValue(ok(metadata))
  const checkPluginUpdate = vi.fn<TavernRemote['checkPluginUpdate']>().mockResolvedValue(ok(update()))
  return { remote: { getPluginAbout, checkPluginUpdate } as unknown as TavernRemote, getPluginAbout, checkPluginUpdate }
}
const mounted = new Set<ReactTestRenderer>()
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.add(view)
  return view
}
async function unmount(view: ReactTestRenderer) {
  await act(async () => view.unmount())
  mounted.delete(view)
}
function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').find(node => node.children.join('') === label)!
}
async function click(view: ReactTestRenderer, label: string) {
  const target = button(view, label)
  expect(target).toBeDefined()
  expect(target.props.disabled).not.toBe(true)
  await act(async () => target.props.onClick({ stopPropagation() {} }))
}
const status = (view: ReactTestRenderer) => view.root.findByProps({ 'aria-live': 'polite' })
const content = (view: ReactTestRenderer) => JSON.stringify(view.toJSON())
const toasts = (view: ReactTestRenderer) => view.root.findAllByProps({ 'data-toast': true }).map(node => node.children.join(''))

beforeEach(() => setTavernLocale('zh'))
afterEach(async () => {
  for (const view of mounted) await act(async () => view.unmount())
  mounted.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('关于页与按需更新检查', () => {
  it('首次仅读取本机信息，等待期间禁用检查，并提供真实 GitHub 链接', async () => {
    const f = fixture(), pending = Promise.withResolvers<Envelope<PluginAbout>>()
    f.getPluginAbout.mockReturnValueOnce(pending.promise)
    const view = await render(<AboutSection remote={f.remote} />)
    expect(f.getPluginAbout).toHaveBeenCalledExactlyOnceWith({})
    expect(f.checkPluginUpdate).not.toHaveBeenCalled()
    expect(button(view, t('about.check')).props.disabled).toBe(true)
    const project = view.root.findByProps({ href: PROJECT })
    expect(project.type).toBe('a')
    expect(project.props).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' })
    await act(async () => pending.resolve(ok(about())))
    expect(content(view)).toContain('0.2.5')
    expect(content(view)).toContain('0.1.5-rc.2')
    expect(button(view, t('about.check')).props.disabled).not.toBe(true)
    expect(f.checkPluginUpdate).not.toHaveBeenCalled()
  })

  it('本机信息读取失败可重试，成功后仍不自动检查发布', async () => {
    const f = fixture()
    f.getPluginAbout.mockResolvedValueOnce(fail('磁盘读取失败'))
    const view = await render(<AboutSection remote={f.remote} />)
    expect(content(view)).toContain(t('about.loadFailed'))
    expect(button(view, t('about.check')).props.disabled).toBe(true)
    await click(view, t('action.retry'))
    expect(f.getPluginAbout).toHaveBeenCalledTimes(2)
    expect(content(view)).not.toContain(t('about.loadFailed'))
    expect(button(view, t('about.check')).props.disabled).not.toBe(true)
    expect(f.checkPluginUpdate).not.toHaveBeenCalled()
  })

  it('新前端遇到旧后台的真实 404 信封时说明需重启，重试成功后恢复', async () => {
    const f = fixture()
    f.getPluginAbout.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal',
      message: 'client api: tavern/getPluginAbout failed: transport failure for /api/tavern/getPluginAbout: HTTP 404' } })
    const view = await render(<AboutSection remote={f.remote} />)
    expect(content(view)).toContain(t('about.restartRequired'))
    expect(content(view)).not.toContain(t('about.loadFailed'))
    expect(button(view, t('about.check')).props.disabled).toBe(true)
    expect(view.root.findByProps({ href: PROJECT }).type).toBe('a')
    expect(view.root.findByProps({ href: `${PROJECT}/releases` }).type).toBe('a')
    await click(view, t('action.retry'))
    expect(content(view)).not.toContain(t('about.restartRequired'))
    expect(button(view, t('about.check')).props.disabled).not.toBe(true)
    expect(f.getPluginAbout).toHaveBeenCalledTimes(2)
    expect(f.checkPluginUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['连接失败', 'client api: tavern/getPluginAbout failed: Failed to fetch'],
    ['磁盘元数据错误', '插件或宿主版本元数据无效，无法检查更新'],
    ['其它路径的 404', 'client api: tavern/getCharacter failed: transport failure for /api/tavern/getCharacter: HTTP 404'],
  ])('%s 保留一般失败提示，不误报需要重启旧后台', async (_label, message) => {
    const f = fixture()
    f.getPluginAbout.mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal', message } })
    const view = await render(<AboutSection remote={f.remote} />)
    expect(content(view)).toContain(t('about.loadFailed'))
    expect(content(view)).not.toContain(t('about.restartRequired'))
    expect(button(view, t('action.retry'))).toBeDefined()
    expect(f.checkPluginUpdate).not.toHaveBeenCalled()
  })

  it('无法确认启动宿主时保留插件信息与发布说明，禁用并守卫更新检查', async () => {
    const f = fixture(about({ hostVersion: 'unknown' }))
    const view = await render(<AboutSection remote={f.remote} />)
    expect(content(view)).toContain('0.2.5')
    expect(content(view)).toContain(t('about.unknown'))
    expect(content(view)).toContain(t('about.hostUnknown'))
    expect(content(view)).not.toContain(t('about.loadFailed'))
    const release = view.root.findByProps({ href: `${PROJECT}/releases` })
    expect(release.type).toBe('a')
    expect(release.children.join('')).toBe(t('about.releases'))
    const check = button(view, t('about.check'))
    expect(check.props.disabled).toBe(true)
    // 模拟已排队的点击回调：不能仅依赖 DOM disabled 阻止错误兼容性检查。
    await act(async () => check.props.onClick({ stopPropagation() {} }))
    expect(f.checkPluginUpdate).not.toHaveBeenCalled()
    expect(status(view).findAllByType('p')).toEqual([])
    expect(button(view, t('about.copyCommand'))).toBeUndefined()
  })

  it('检查期间禁用按钮，同次提交前的重复点击也只发出一次请求', async () => {
    const f = fixture(), pending = Promise.withResolvers<Envelope<PluginUpdate>>()
    f.checkPluginUpdate.mockReturnValueOnce(pending.promise)
    const view = await render(<AboutSection remote={f.remote} />)
    const action = button(view, t('about.check')).props.onClick as (event: { stopPropagation(): void }) => void
    await act(async () => { action({ stopPropagation() {} }); action({ stopPropagation() {} }) })
    expect(f.checkPluginUpdate).toHaveBeenCalledExactlyOnceWith({})
    expect(button(view, t('about.checking')).props.disabled).toBe(true)
    await act(async () => pending.resolve(ok(update({ status: 'current', command: null }))))
    expect(button(view, t('about.check')).props.disabled).not.toBe(true)
    expect(status(view).findByType('p').children.join('')).toBe(t('about.current', { version: '0.2.6' }))
  })

  it('正确说明四种版本状态，只有可更新且有命令的安装版展示更新步骤', async () => {
    const cases: Array<{ status: PluginUpdate['status']; command: string | null; source: boolean; copy: boolean }> = [
      { status: 'current', command: COMMAND, source: false, copy: false },
      { status: 'ahead', command: COMMAND, source: false, copy: false },
      { status: 'incompatible', command: COMMAND, source: false, copy: false },
      { status: 'available', command: COMMAND, source: false, copy: true },
      { status: 'available', command: null, source: false, copy: false },
      { status: 'available', command: COMMAND, source: true, copy: false },
    ]
    for (const item of cases) {
      const f = fixture(about({ sourceCheckout: item.source }))
      f.checkPluginUpdate.mockResolvedValue(ok(update({ status: item.status, command: item.command })))
      const view = await render(<AboutSection remote={f.remote} />)
      await click(view, t('about.check'))
      expect(status(view).findByType('p').children.join('')).toBe(t(`about.${item.status}`, { version: '0.2.6', host: '0.1.5-rc.2' }))
      expect(Boolean(button(view, t('about.copyCommand')))).toBe(item.copy)
      expect(view.root.findAllByType('code').map(node => node.children.join(''))).toEqual(item.copy ? [COMMAND] : [])
      expect(view.root.findByProps({ href: `${PROJECT}/releases/tag/v0.2.6` }).type).toBe('a')
      if (item.source) expect(content(view)).toContain(t('about.sourceHint'))
      await unmount(view)
    }
  })

  it('复制等待真实剪贴板成功；失败给出手动复制提示并支持再次复制', async () => {
    const pending = Promise.withResolvers<void>()
    const writeText = vi.fn<(text: string) => Promise<void>>().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const f = fixture(), view = await render(<AboutSection remote={f.remote} />)
    await click(view, t('about.check'))
    await click(view, t('about.copyCommand'))
    expect(writeText).toHaveBeenCalledExactlyOnceWith(COMMAND)
    expect(toasts(view)).toEqual([])
    await act(async () => pending.reject(new Error('clipboard denied')))
    expect(toasts(view)).toEqual([t('about.copyFailed')])
    expect(toasts(view)).not.toContain(t('about.copied'))
    await click(view, t('about.copyCommand'))
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(toasts(view)).toEqual([t('about.copied')])
  })

  it('检查的业务失败和连接异常都解除忙碌并允许重试', async () => {
    const f = fixture()
    f.checkPluginUpdate.mockResolvedValueOnce(fail('GitHub 限流')).mockRejectedValueOnce(new Error('断开连接'))
    const view = await render(<AboutSection remote={f.remote} />)
    for (let attempt = 0; attempt < 2; attempt++) {
      await click(view, t('about.check'))
      expect(content(view)).toContain(t('about.checkFailed'))
      expect(button(view, t('about.check')).props.disabled).not.toBe(true)
      expect(button(view, t('about.copyCommand'))).toBeUndefined()
    }
    await click(view, t('about.check'))
    expect(content(view)).not.toContain(t('about.checkFailed'))
    expect(button(view, t('about.copyCommand'))).toBeDefined()
    expect(f.checkPluginUpdate).toHaveBeenCalledTimes(3)
    expect(f.getPluginAbout).toHaveBeenCalledTimes(1)
  })

  it('检查超时可重试，超时请求的迟到结果不能覆盖新结果', async () => {
    vi.useFakeTimers()
    const f = fixture(), pending = Promise.withResolvers<Envelope<PluginUpdate>>()
    f.checkPluginUpdate.mockReturnValueOnce(pending.promise).mockResolvedValue(ok(update({ status: 'current', command: null })))
    const view = await render(<AboutSection remote={f.remote} />)
    await click(view, t('about.check'))
    await act(async () => vi.advanceTimersByTimeAsync(20_000))
    expect(content(view)).toContain(t('about.checkFailed'))
    await click(view, t('about.check'))
    await act(async () => pending.resolve(ok(update({ latestVersion: '9.9.9' }))))
    expect(status(view).findByType('p').children.join('')).toBe(t('about.current', { version: '0.2.6' }))
    expect(content(view)).not.toContain('9.9.9')
    expect(button(view, t('about.copyCommand'))).toBeUndefined()
    expect(f.checkPluginUpdate).toHaveBeenCalledTimes(2)
  })

  it('切换 remote 后不消费旧连接的迟到本机信息', async () => {
    const old = fixture(), latest = fixture(about({ version: '0.3.0' }))
    const pending = Promise.withResolvers<Envelope<PluginAbout>>()
    old.getPluginAbout.mockReturnValueOnce(pending.promise)
    const view = await render(<AboutSection remote={old.remote} />)
    await act(async () => view.update(<AboutSection remote={latest.remote} />))
    await act(async () => pending.resolve(ok(about({ version: '9.9.9', sourceCheckout: true }))))
    expect(content(view)).toContain('0.3.0')
    expect(content(view)).not.toContain('9.9.9')
    expect(content(view)).not.toContain(t('about.sourceHint'))
    expect(old.checkPluginUpdate).not.toHaveBeenCalled()
    expect(latest.checkPluginUpdate).not.toHaveBeenCalled()
  })

  it('切换 remote 后旧检查与剪贴板回执不能污染当前页面', async () => {
    const clipboard = Promise.withResolvers<void>(), pending = Promise.withResolvers<Envelope<PluginUpdate>>()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => clipboard.promise) } })
    const old = fixture(), latest = fixture(about({ version: '0.3.0' }))
    old.checkPluginUpdate.mockResolvedValueOnce(ok(update())).mockReturnValueOnce(pending.promise)
    latest.checkPluginUpdate.mockResolvedValue(ok(update({ status: 'current', latestVersion: '0.3.0', command: null })))
    const view = await render(<AboutSection remote={old.remote} />)
    await click(view, t('about.check'))
    await click(view, t('about.copyCommand'))
    await click(view, t('about.check'))
    await act(async () => view.update(<AboutSection remote={latest.remote} />))
    expect(button(view, t('about.check')).props.disabled).not.toBe(true)
    expect(status(view).findAllByType('p')).toEqual([])
    await click(view, t('about.check'))
    await act(async () => { pending.resolve(ok(update({ latestVersion: '9.9.9' }))); clipboard.resolve() })
    expect(status(view).findByType('p').children.join('')).toBe(t('about.current', { version: '0.3.0' }))
    expect(content(view)).not.toContain('9.9.9')
    expect(toasts(view)).toEqual([])
  })

  it('卸载后迟到检查失败和复制失败被收口，重新打开从本机信息开始', async () => {
    const pending = Promise.withResolvers<Envelope<PluginUpdate>>(), clipboard = Promise.withResolvers<void>()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => clipboard.promise) } })
    const f = fixture()
    f.checkPluginUpdate.mockResolvedValueOnce(ok(update())).mockReturnValueOnce(pending.promise)
    const view = await render(<AboutSection remote={f.remote} />)
    await click(view, t('about.check'))
    await click(view, t('about.copyCommand'))
    await click(view, t('about.check'))
    await unmount(view)
    await act(async () => { pending.reject(new Error('late check failure')); clipboard.reject(new Error('late clipboard failure')) })
    const reopened = await render(<AboutSection remote={f.remote} />)
    expect(status(reopened).findAllByType('p')).toEqual([])
    expect(content(reopened)).not.toContain(t('about.checkFailed'))
    expect(toasts(reopened)).toEqual([])
    expect(f.getPluginAbout).toHaveBeenCalledTimes(2)
    expect(f.checkPluginUpdate).toHaveBeenCalledTimes(2)
  })
})
