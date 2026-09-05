/**
 * 设置面板分区：全局正则脚本（列表 + enabled 开关 + 编辑，整表保存）。
 * find/replace 等代码向输入用 code 字体类；保存反馈走 useToast，上下文错误用 Err。
 */
import { useDraftGuard } from '../drafts.js'
import { useDraftState } from '../draftPersistence.js'
import { useEffect, useState } from 'react'
import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptPreset, RegexRule, RegexScope, RegexTiming } from '../../core/types.js'
import type { TavernRemote } from '../types.js'
import { t as tOnce, useT } from '../i18n.js'
import { Badge, Btn, CheckChips, Err, Field, IconBtn, Muted, NullableNumInput, RegexScriptRow, SaveBar, Section, Select, Skeleton, Toggle, errOf, runAsync, useLoader, useToast } from '../util.js'

const SCOPES: { value: RegexScope; labelKey: string }[] = [
  { value: 'input', labelKey: 'regex.scope.input' },
  { value: 'output', labelKey: 'regex.scope.output' },
  { value: 'prompt', labelKey: 'regex.scope.prompt' },
]
const TIMINGS: { value: RegexTiming; labelKey: string }[] = [
  { value: 'assemble', labelKey: 'regex.timing.assemble' },
  { value: 'send', labelKey: 'regex.timing.send' },
  { value: 'render', labelKey: 'regex.timing.render' },
]
const SOURCE_LABEL_KEY: Record<RegexRule['source'], string> = { user: 'regex.source.user', card: 'regex.source.card', preset: 'regex.source.preset' }

function newRule(): RegexRule {
  return {
    id: `rule-${Date.now().toString(36)}`,
    name: tOnce('regex.newRuleName'),
    find: '',
    replace: '',
    enabled: true,
    scopes: ['output'],
    timing: ['render'],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 0,
    source: 'user',
  }
}

function RuleEditor(props: { rule: RegexRule; onChange: (r: RegexRule) => void; onDelete: () => void }) {
  const t = useT()
  const { rule } = props
  const set = (patch: Partial<RegexRule>) => props.onChange({ ...rule, ...patch })
  return (
    <div className="dsh-tavern-entry" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 16px 8px' }}>
        <Toggle checked={rule.enabled} onChange={(enabled) => set({ enabled })} title={rule.enabled ? t('regex.toggleDisable') : t('regex.toggleEnable')} />
        <input className="dsh-tavern-input" style={{ flex: 1 }} value={rule.name} onChange={(e) => set({ name: e.target.value })} />
        <Badge>{t(SOURCE_LABEL_KEY[rule.source])}</Badge>
        <IconBtn label={t('regex.deleteRule')} danger onClick={props.onDelete}>
          <IconTrashOutline16 />
        </IconBtn>
      </div>
      <div style={{ padding: '2px 16px 14px' }}>
      <Field label={t('regex.find')}>
        <input className="dsh-tavern-input dsh-tavern-codeFont" style={{ flex: 1 }} value={rule.find} onChange={(e) => set({ find: e.target.value })} />
      </Field>
      <div className="dsh-tavern-fieldLabel" style={{ margin: '4px 0' }}>{t('regex.replace')}</div>
      <textarea className="dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont" style={{ minHeight: 40 }} value={rule.replace} onChange={(e) => set({ replace: e.target.value })} />
      <div className="dsh-tavern-fieldRow" style={{ margin: '8px 0 4px' }}>
        <div className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">{t('regex.scope')}</span>
          <CheckChips
            ariaLabel={t('regex.scope')}
            options={SCOPES.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            selected={rule.scopes}
            onChange={(scopes) => set({ scopes: scopes as RegexScope[] })}
          />
        </div>
        <div className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">{t('regex.timing')}</span>
          <CheckChips
            ariaLabel={t('regex.timing')}
            options={TIMINGS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
            selected={rule.timing}
            onChange={(timing) => set({ timing: timing as RegexTiming[] })}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, alignItems: 'center' }}>
        <label>
          {t('regex.minDepth')} <NullableNumInput value={rule.minDepth} width={64} onChange={(v) => set({ minDepth: v })} />
        </label>
        <label>
          {t('regex.maxDepth')} <NullableNumInput value={rule.maxDepth} width={64} onChange={(v) => set({ maxDepth: v })} />
        </label>
        <label>
          {t('regex.macroExpand')}{' '}
          <Select
            value={String(rule.substituteRegex)}
            onChange={(v) => set({ substituteRegex: Number(v) as RegexRule['substituteRegex'] })}
            options={[
              { value: '0', label: t('regex.substitute.none') },
              { value: '1', label: t('regex.substitute.raw') },
              { value: '2', label: t('regex.substitute.escaped') },
            ]}
          />
        </label>
      </div>
      </div>
    </div>
  )
}

export function RegexSection(props: { remote: TavernRemote }) {
  const t = useT()
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listRegexRules({}), [])
  const [rules, setRules] = useDraftState<RegexRule[] | null>('regex:rules', null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const [savedRules, setSavedRules] = useDraftState<string | null>('regex:savedRules', null)
  useDraftGuard(rules !== null && JSON.stringify(rules) !== (savedRules ?? (state.status === 'ready' ? JSON.stringify(state.value.rules) : null)), busy)

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
    // 乐观开关失败（错误信封或传输 reject）都回滚草稿；reject 经 runAsync 落 setError，
    // 不留未处理 rejection；busy 期间 RegexScriptRow 开关禁用，防连续切换互相覆盖。
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePreset({ preset: nextPreset }).catch((e: unknown) => {
        setPresetDrafts(drafts)
        throw e
      })
      const err = errOf(r)
      if (err) {
        setError(err)
        setPresetDrafts(drafts)
      } else {
        const name = script.scriptName?.trim() || t('util.regex.unnamed', { index: si + 1 })
        toast.show(disabled ? t('regex.toggledOff', { name }) : t('regex.toggledOn', { name }))
      }
    })
  }

  const save = (next: RegexRule[]) =>
    runAsync(setBusy, setError, async () => {
      const r = await remote.saveRegexRules({ rules: next })
      const err = errOf(r)
      if (err) setError(err)
      else { setSavedRules(JSON.stringify(next)); toast.show(t('regex.saved', { count: next.length })) }
    })

  const current = rules ?? []
  return (
    <Section description={t('regex.liveNotice')} title={t('section.regex')}>
      {toast.node}
      <Muted>
        {t('regex.desc')}
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
        <div className="dsh-tavern-regexCustom">
          <div className="dsh-tavern-groupHead">{t('regex.customHead')}</div>
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
          {current.length === 0 && (
            <div className="dsh-tavern-regexEmpty">
              <div className="dsh-tavern-emptyTitle">{t('regex.emptyTitle')}</div>
              <div className="dsh-tavern-emptyDesc">{t('regex.emptyDesc')}</div>
            </div>
          )}
          <SaveBar inline>
            <Btn onClick={() => setRules([...current, newRule()])}>{t('regex.new')}</Btn>
            <Btn disabled={busy} onClick={() => void save(current)} primary>{t('regex.saveAll')}</Btn>
            <Btn
              onClick={() => {
                setRules(null)
                reload()
              }}
            >
              {t('regex.discard')}
            </Btn>
          </SaveBar>
        </div>
      )}

      <div className="dsh-tavern-regexPresets">
        <div className="dsh-tavern-groupHead">{t('regex.presetHead')}</div>
        {presetRegex.state.status === 'loading' && (
          <>
            <Skeleton height={56} />
            <Skeleton height={56} />
          </>
        )}
        {presetRegex.state.status === 'error' && <Err message={presetRegex.state.message} />}
        {presetDrafts !== null && presetDrafts.length === 0 && (
          <Muted>{t('regex.noPresetRegex')}</Muted>
        )}
        {(presetDrafts ?? []).map((preset, pi) => (
          <div className="dsh-tavern-regexPreset" key={preset.identifier}>
            <div className="dsh-tavern-fieldLabel">
              {t('regex.presetCount', { name: preset.name?.trim() || preset.identifier, count: preset.regexScripts!.length })}
            </div>
            <div className="dsh-tavern-list">
              {preset.regexScripts!.map((s, si) => (
                <RegexScriptRow key={s.id ?? si} script={s} index={si} disabled={busy} onToggle={(disabled) => void togglePresetScript(pi, si, disabled)} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}
