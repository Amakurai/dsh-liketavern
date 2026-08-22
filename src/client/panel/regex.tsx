/**
 * 设置面板分区：全局正则脚本（列表 + enabled 开关 + 编辑，整表保存）。
 * find/replace 等代码向输入用 code 字体类；保存反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react'
import type { PromptPreset, RegexRule, RegexScope, RegexTiming } from '../../core/types.js'
import type { TavernRemote } from '../types.js'
import { Btn, Err, Field, Muted, NullableNumInput, RegexScriptRow, Section, Select, Skeleton, Toggle, errOf, runAsync, useLoader, useToast } from '../util.js'

const SCOPES: { value: RegexScope; label: string }[] = [
  { value: 'input', label: '用户输入' },
  { value: 'output', label: 'AI 输出' },
  { value: 'prompt', label: '发送给模型' },
]
const TIMINGS: { value: RegexTiming; label: string }[] = [
  { value: 'assemble', label: '组装前' },
  { value: 'send', label: '发送前' },
  { value: 'render', label: '渲染前' },
]

function newRule(): RegexRule {
  return {
    id: `rule-${Date.now().toString(36)}`,
    name: '新规则',
    find: '',
    replace: '',
    enabled: true,
    scopes: ['prompt'],
    timing: ['send'],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 0,
    source: 'user',
  }
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

function RuleEditor(props: { rule: RegexRule; onChange: (r: RegexRule) => void; onDelete: () => void }) {
  const { rule } = props
  const set = (patch: Partial<RegexRule>) => props.onChange({ ...rule, ...patch })
  return (
    <div className="dsh-tavern-entry" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px 6px' }}>
        <Toggle checked={rule.enabled} onChange={(enabled) => set({ enabled })} title={rule.enabled ? '关闭此规则' : '启用此规则'} />
        <input className="dsh-tavern-input" style={{ flex: 1 }} value={rule.name} onChange={(e) => set({ name: e.target.value })} />
        <Muted>{rule.source === 'user' ? '用户' : rule.source === 'card' ? '角色卡' : '预设'}</Muted>
        <Btn danger onClick={props.onDelete}>删除</Btn>
      </div>
      <div style={{ padding: '0 12px 12px' }}>
      <Field label="查找 (find)">
        <input className="dsh-tavern-input dsh-tavern-codeFont" style={{ flex: 1 }} value={rule.find} onChange={(e) => set({ find: e.target.value })} />
      </Field>
      <div className="dsh-tavern-fieldLabel" style={{ margin: '4px 0' }}>替换 (replace)</div>
      <textarea className="dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont" style={{ minHeight: 40 }} value={rule.replace} onChange={(e) => set({ replace: e.target.value })} />
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, margin: '6px 0' }}>
        <span>
          作用域：
          {SCOPES.map((s) => (
            <label key={s.value} style={{ marginLeft: 8 }}>
              <input type="checkbox" checked={rule.scopes.includes(s.value)} onChange={() => set({ scopes: toggle(rule.scopes, s.value) })} /> {s.label}
            </label>
          ))}
        </span>
        <span>
          时机：
          {TIMINGS.map((t) => (
            <label key={t.value} style={{ marginLeft: 8 }}>
              <input type="checkbox" checked={rule.timing.includes(t.value)} onChange={() => set({ timing: toggle(rule.timing, t.value) })} /> {t.label}
            </label>
          ))}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, alignItems: 'center' }}>
        <label>
          最小深度 <NullableNumInput value={rule.minDepth} width={64} onChange={(v) => set({ minDepth: v })} />
        </label>
        <label>
          最大深度 <NullableNumInput value={rule.maxDepth} width={64} onChange={(v) => set({ maxDepth: v })} />
        </label>
        <label>
          宏展开{' '}
          <Select
            value={String(rule.substituteRegex)}
            onChange={(v) => set({ substituteRegex: Number(v) as RegexRule['substituteRegex'] })}
            options={[
              { value: '0', label: '不展开' },
              { value: '1', label: '原样代入' },
              { value: '2', label: '转义代入' },
            ]}
          />
        </label>
      </div>
      </div>
    </div>
  )
}

export function RegexSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listRegexRules({}), [])
  const [rules, setRules] = useState<RegexRule[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  useEffect(() => {
    if (state.status === 'ready' && rules === null) setRules(structuredClone(state.value.rules))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // 预设附带的正则：列出所有带 regexScripts 的预设，开关直接改写预设文件（不动上方 rules.json 草稿）。
  const presetRegex = useLoader(
    async () => {
      const list = await remote.listPresets({})
      if (!list.ok) return list
      const items: PromptPreset[] = []
      for (const p of list.value.items) {
        if (p.regexCount <= 0) continue
        const r = await remote.getPreset({ id: p.id })
        if (r.ok && (r.value.preset.regexScripts?.length ?? 0) > 0) items.push(r.value.preset)
      }
      return { ok: true as const, value: { items } }
    },
    [],
  )
  const [presetDrafts, setPresetDrafts] = useState<PromptPreset[] | null>(null)
  useEffect(() => {
    if (presetRegex.state.status === 'ready' && presetDrafts === null) setPresetDrafts(structuredClone(presetRegex.state.value.items))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetRegex.state])

  const togglePresetScript = async (pi: number, si: number, disabled: boolean) => {
    const drafts = presetDrafts ?? []
    const preset = drafts[pi]
    const script = preset?.regexScripts?.[si]
    if (!preset || !script) return
    const nextPreset: PromptPreset = {
      ...preset,
      regexScripts: preset.regexScripts!.map((s, i) => (i === si ? { ...s, disabled } : s)),
    }
    setPresetDrafts(drafts.map((p, i) => (i === pi ? nextPreset : p)))
    const r = await remote.savePreset({ preset: nextPreset })
    const err = errOf(r)
    if (err) {
      setError(err)
      setPresetDrafts(drafts)
    } else {
      const name = script.scriptName?.trim() || `预设正则 ${si + 1}`
      toast.show(disabled ? `已关闭「${name}」` : `已启用「${name}」`)
    }
  }

  const save = (next: RegexRule[]) =>
    runAsync(setBusy, setError, async () => {
      const r = await remote.saveRegexRules({ rules: next })
      const err = errOf(r)
      if (err) setError(err)
      else toast.show(`已保存 ${next.length} 条规则`)
    })

  const current = rules ?? []
  return (
    <Section title="正则脚本">
      {toast.node}
      <Muted>
        对话展示会自动收起 UpdateVariable、JSONPatch 等机读标签，不依赖预设是否带了正则。上方是你额外要改写展示或入模的规则；下方列出预设随带的正则，可直接开关。
      </Muted>
      {state.status === 'loading' && (
        <>
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
        </>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      <Err message={error} />
      {rules !== null && (
        <>
          {current.map((rule, i) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              onChange={(r) => {
                const next = current.slice()
                next[i] = r
                setRules(next)
              }}
              onDelete={() => setRules(current.filter((_, j) => j !== i))}
            />
          ))}
          {current.length === 0 && <Muted>暂无规则。</Muted>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Btn onClick={() => setRules([...current, newRule()])}>新建规则</Btn>
            <Btn disabled={busy} onClick={() => void save(current)} primary>保存全部</Btn>
            <Btn
              onClick={() => {
                setRules(null)
                reload()
              }}
            >
              放弃更改并刷新
            </Btn>
          </div>
        </>
      )}

      <div className="dsh-tavern-groupHead">预设附带</div>
      {presetRegex.state.status === 'loading' && (
        <>
          <Skeleton height={56} />
          <Skeleton height={56} />
        </>
      )}
      {presetRegex.state.status === 'error' && <Err message={presetRegex.state.message} />}
      {presetDrafts !== null && presetDrafts.length === 0 && (
        <Muted>没有预设携带正则。预设 JSON 里 extensions.regex_scripts 会随导入带进来，可在「预设」页查看。</Muted>
      )}
      {(presetDrafts ?? []).map((preset, pi) => (
        <div key={preset.identifier}>
          <div className="dsh-tavern-fieldLabel" style={{ margin: '12px 0 6px' }}>
            {preset.name?.trim() || preset.identifier}（{preset.regexScripts!.length} 条）
          </div>
          <div className="dsh-tavern-list">
            {preset.regexScripts!.map((s, si) => (
              <RegexScriptRow key={s.id ?? si} script={s} index={si} onToggle={(disabled) => void togglePresetScript(pi, si, disabled)} />
            ))}
          </div>
        </div>
      ))}
    </Section>
  )
}
