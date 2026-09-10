/** 共享表单交互回归：选项值不与占位项碰撞，过期菜单不写草稿，字段标签关联实际操作控件。 */
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import { Field, ListInput, NumInput, Select, SettingsRow, Toggle } from '../src/client/util.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Modal: () => null, Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
}))
const mounted: ReactTestRenderer[] = []
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()) })

describe('共享表单控件', () => {
  it('空选项与名为 __empty__ 的资产可以分别选中，未知选项不触发更新', async () => {
    const change = vi.fn()
    const view = await render(<Select value="" onChange={change} options={[{value:'',label:'未选择'},{value:'__empty__',label:'资产'}]}/>)
    const menu = view.root.findByType(Menu)
    const [empty, asset] = menu.props.items as {id:string}[]
    expect(empty!.id).not.toBe(asset!.id)
    await act(async () => menu.props.onSelect(asset!.id))
    expect(change).toHaveBeenLastCalledWith('__empty__')
    await act(async () => menu.props.onSelect(empty!.id))
    expect(change).toHaveBeenLastCalledWith('')
    await act(async () => menu.props.onSelect('unknown'))
    expect(change).toHaveBeenCalledTimes(2)
  })

  it('下拉已展开后控件禁用，关闭弹层且忽略迟到选择', async () => {
    const change = vi.fn(), options = [{value:'one',label:'选项'}]
    const view = await render(<Select value="one" onChange={change} options={options}/>)
    await act(async () => view.root.findByType('button').props.onClick())
    expect(view.root.findByType(Menu).props.open).toBe(true)
    await act(async () => view.update(<Select value="one" onChange={change} options={options} disabled/>))
    const menu = view.root.findByType(Menu)
    expect(menu.props.open).toBe(false)
    await act(async () => menu.props.onSelect(menu.props.items[0].id))
    expect(change).not.toHaveBeenCalled()
  })

  it('设置行标签和说明关联开关、数值和原生文本框，显式标签仍优先', async () => {
    const view = await render(<>
      <SettingsRow title="启用渲染" description="渲染说明"><Toggle checked onChange={()=>{}}/></SettingsRow>
      <SettingsRow title="保留条数"><NumInput value={200} onChange={()=>{}}/></SettingsRow>
      <Field label="正文"><textarea defaultValue=""/></Field>
      <Field label="外层名称"><textarea aria-label="明确的名称" defaultValue=""/></Field>
    </>)
    const toggle = view.root.findByProps({role:'switch'})
    expect(view.root.findByProps({id:toggle.props['aria-labelledby']}).children).toEqual(['启用渲染'])
    expect(view.root.findByProps({id:toggle.props['aria-describedby']}).children).toEqual(['渲染说明'])
    const input = view.root.findByType('input')
    expect(view.root.findByProps({id:input.props['aria-labelledby']}).children).toEqual(['保留条数'])
    const [implicit, explicit] = view.root.findAllByType('textarea')
    expect(view.root.findByProps({id:implicit!.props['aria-labelledby']}).children).toEqual(['正文'])
    expect(explicit!.props['aria-label']).toBe('明确的名称')
    expect(explicit!.props['aria-labelledby']).toBeUndefined()
  })

  it('关键词列表输入保留正在键入的分隔符与空格，外部切换值时才覆盖文本', async () => {
    const changes: string[][] = []
    function Form(props: { initial: string[] }) {
      const [keys, setKeys] = useState(props.initial)
      return <>
        <Field label="关键词"><ListInput value={keys} onChange={(next) => { changes.push(next); setKeys(next) }}/></Field>
        <button onClick={() => setKeys(['外部', '重置'])}>外部重置</button>
      </>
    }
    const view = await render(<Form initial={['a']}/>)
    const input = () => view.root.findByType('input')
    expect(view.root.findByProps({id:input().props['aria-labelledby']}).children).toEqual(['关键词'])
    const type = async (text: string) => act(async () => input().props.onChange({ target: { value: text } }))
    await type('a,')
    expect(input().props.value).toBe('a,')
    await type('a, ')
    expect(input().props.value).toBe('a, ')
    await type('a, b')
    expect(input().props.value).toBe('a, b')
    expect(changes.at(-1)).toEqual(['a', 'b'])
    await type('a, b，c\n')
    expect(changes.at(-1)).toEqual(['a', 'b', 'c'])
    await type('')
    expect(input().props.value).toBe('')
    expect(changes.at(-1)).toEqual([])
    await act(async () => view.root.findByType('button').props.onClick())
    expect(input().props.value).toBe('外部, 重置')
    await type('外部, 重置,')
    expect(input().props.value).toBe('外部, 重置,')
  })
})
