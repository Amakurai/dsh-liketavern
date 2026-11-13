/**
 * 设置面板分区：全局正则脚本（列表 + enabled 开关 + 编辑，整表保存）。
 * find/replace 等代码向输入用 code 字体类；保存反馈走 useToast，上下文错误用 Err。
 */
import { describeError } from '../../core/guards.js'
import { parseImportedRegexRules } from '../../core/regex.js'
import { useDraftGuard } from '../drafts.js'
import { useDraftState } from '../draftPersistence.js'
import { randomUuid } from '../../core/secureRandom.js'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconTrashOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptPreset, RegexRule, RegexScope, RegexTiming } from '../../core/types.js'
import type { TavernRemote } from '../types.js'
import { t as tOnce, useT } from '../i18n.js'
import { Badge, Btn, CheckChips, ConfirmDialog, Err, Field, FileBtn, IconBtn, Muted, NullableNumInput, RegexScriptRow, SaveBar, Section, Select, Skeleton, Toggle, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js'

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
type PresetDraft = PromptPreset & { editId: string; editRevision?: string }

function newRule(): RegexRule {
  return {
    id: `rule-${randomUuid()}`,
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

const RuleEditor = memo(function RuleEditor(props: {
  rule: RegexRule
  index: number
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (index: number, delta: -1 | 1) => void
  onChange: (index: number, r: RegexRule) => void
  onDelete: (index: number) => void
}) {
  const t = useT()
  const { rule, index } = props
  const set = (patch: Partial<RegexRule>) => props.onChange(index, { ...rule, ...patch })
  return (
    <div className="dsh-tavern-entry" style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 16px 8px' }}>
        <Toggle checked={rule.enabled} onChange={(enabled) => set({ enabled })} title={rule.enabled ? t('regex.toggleDisable') : t('regex.toggleEnable')} />
        <input aria-label={t('regex.ruleName')} className="dsh-tavern-input" style={{ flex: 1 }} value={rule.name} onChange={(e) => set({ name: e.target.value })} />
        <Badge>{t(SOURCE_LABEL_KEY[rule.source])}</Badge>
        <IconBtn label={t('regex.moveUp')} disabled={!props.canMoveUp} onClick={() => props.onMove(index, -1)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </IconBtn>
        <IconBtn label={t('regex.moveDown')} disabled={!props.canMoveDown} onClick={() => props.onMove(index, 1)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </IconBtn>
        <IconBtn label={t('regex.deleteRule')} danger onClick={() => props.onDelete(index)}>
          <IconTrashOutlineMedium />
        </IconBtn>
      </div>
      <div style={{ padding: '2px 16px 14px' }}>
      <Field label={t('regex.find')}>
        <input className="dsh-tavern-input dsh-tavern-codeFont" style={{ flex: 1 }} value={rule.find} onChange={(e) => set({ find: e.target.value })} />
      </Field>
      <Field label={t('regex.replace')}>
        <textarea className="dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont" style={{ minHeight: 40 }} value={rule.replace} onChange={(e) => set({ replace: e.target.value })} />
      </Field>
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
})

export function RegexSection(props: { remote: TavernRemote }) {
  const t = useT()
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listRegexRules({}), [])
  const [rules, setRules] = useDraftState<RegexRule[] | null>('regex:rules', null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const toast = useToast()
  const [savedRules, setSavedRules] = useDraftState<string | null>('regex:savedRules', null)
  const [revision, setRevision] = useDraftState<string | null>('regex:revision', null)
  const saving = useRef(false)
  const baselineRules = savedRules ?? (state.status === 'ready' ? JSON.stringify(state.value.rules) : null)
  const dirty = useMemo(
    () => rules !== null && JSON.stringify(rules) !== baselineRules,
    [rules, baselineRules],
  )
  useDraftGuard(dirty, busy)

  useEffect(() => {
    if (state.status === 'ready' && rules === null) {
      setRules(structuredClone(state.value.rules))
      // 放弃后重拉的服务器版本成为新基线；不能继续用刷新前那次保存的快照判断脏状态。
      setSavedRules(JSON.stringify(state.value.rules))
      setRevision(state.value.revision ?? null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // 预设附带的正则：列出所有带 regexScripts 的预设，开关直接改写预设文件（不动上方 rules.json 草稿）。
  const presetRegex = useLoader(
    async () => {
      const list = await remote.listPresets({})
      if (!list.ok) return list
      const candidates = list.value.items.filter((p) => p.regexCount > 0)
      const loaded = await Promise.all(candidates.map(async (p) => ({ id: p.id, r: await remote.getPreset({ id: p.id }) })))
      const items: PresetDraft[] = []
      for (const { id, r } of loaded) {
        if (!r.ok) return r
        if ((r.value.preset.regexScripts?.length ?? 0) > 0) items.push({ ...r.value.preset, editId: id, editRevision: r.value.revision })
      }
      return { ok: true as const, value: { items } }
    },
    [],
  )
  const [presetDrafts, setPresetDrafts] = useState<PresetDraft[] | null>(null)
  useEffect(() => {
    if (presetRegex.state.status === 'ready' && presetDrafts === null) setPresetDrafts(structuredClone(presetRegex.state.value.items))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetRegex.state])

  const togglePresetScript = async (pi: number, si: number, disabled: boolean) => {
    if (saving.current) return
    const drafts = presetDrafts ?? []
    const preset = drafts[pi]
    const script = preset?.regexScripts?.[si]
    if (!preset || !script) return
    if (!preset.editRevision) { setError(t('presets.missingRevision')); return }
    const nextPreset: PresetDraft = {
      ...preset,
      regexScripts: preset.regexScripts!.map((s, i) => (i === si ? { ...s, disabled } : s)),
    }
    setPresetDrafts(drafts.map((p, i) => (i === pi ? nextPreset : p)))
    saving.current = true
    // 乐观开关失败（错误信封或传输 reject）都回滚草稿；reject 经 runAsync 落 setError，
    // 不留未处理 rejection；busy 期间 RegexScriptRow 开关禁用，防连续切换互相覆盖。
    try { await runAsync(setBusy, setError, async () => {
      const { editId, editRevision, ...content } = nextPreset
      const r = await remote.savePreset({ preset: content, id: editId, expectedRevision: editRevision }).catch((e: unknown) => {
        setPresetDrafts(drafts)
        throw e
      })
      const err = errOf(r)
      if (err) {
        setError(err)
        setPresetDrafts(drafts)
      } else if (r.ok) {
        setPresetDrafts(drafts.map((p, i) => i === pi ? { ...nextPreset, editRevision: r.value.revision } : p))
        const name = script.scriptName?.trim() || t('util.regex.unnamed', { index: si + 1 })
        toast.show(disabled ? t('regex.toggledOff', { name }) : t('regex.toggledOn', { name }))
      }
    }) } finally { saving.current = false }
  }

  const save = async (next: RegexRule[]) => {
    if (saving.current) return
    if (!revision) { setError(t('regex.missingRevision')); return }
    saving.current = true
    try { await runAsync(setBusy, setError, async () => {
      const r = await remote.saveRegexRules({ rules: next, expectedRevision: revision })
      const err = errOf(r)
      if (err) setError(err)
      else if (r.ok) { setSavedRules(JSON.stringify(next)); setRevision(r.value.revision ?? null); toast.show(t('regex.saved', { count: next.length })) }
    }) } finally { saving.current = false }
  }

  const current = rules ?? []
  const [ruleLimit, setRuleLimit] = useState(40)
  const shownRules = current.slice(0, ruleLimit)
  const moveRule = useCallback((index: number, delta: -1 | 1) => {
    setRules((prev) => {
      if (!prev) return prev
      const target = index + delta
      if (target < 0 || target >= prev.length) return prev
      const next = prev.slice()
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved!)
      return next
    })
  }, [setRules])
  const updateRule = useCallback((index: number, r: RegexRule) => {
    setRules((prev) => {
      if (!prev) return prev
      const next = prev.slice()
      next[index] = r
      return next
    })
  }, [setRules])
  const removeRule = useCallback((index: number) => {
    setRules((prev) => (prev ? prev.filter((_, j) => j !== index) : prev))
  }, [setRules])
  const discardNow = () => {
    setConfirmDiscard(false)
    setRules(null)
    setSavedRules(null)
    setRevision(null)
    reload()
  }
  const importRules = async (file: File) => {
    if (saving.current) return
    try {
      const raw = await readJsonFile(file)
      const imported = parseImportedRegexRules(raw)
      if (imported.length === 0) {
        setError(t('regex.importEmpty'))
        return
      }
      setError(null)
      setRules((prev) => {
        const next = [...(prev ?? []), ...imported]
        setRuleLimit((n) => Math.max(n, next.length))
        return next
      })
      toast.show(t('regex.imported', { count: imported.length }))
    } catch (cause) {
      setError(describeError(cause))
    }
  }
  return (
    <Section description={t('regex.liveNotice')} title={t('section.regex')}>
      {toast.node}
      <ConfirmDialog
        open={confirmDiscard}
        title={t('regex.discardTitle')}
        description={t('regex.discardConfirm')}
        confirmLabel={t('regex.discardConfirmAction')}
        danger
        busy={busy}
        onCancel={() => { if (!busy) setConfirmDiscard(false) }}
        onConfirm={discardNow}
      />
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
      {state.status === 'error' && <>
        <Err message={state.message} />
        <Btn disabled={busy} onClick={reload}>{t('action.retry')}</Btn>
      </>}
      <Err message={error} />
      {rules !== null && (
        <div className="dsh-tavern-regexCustom">
          <div className="dsh-tavern-groupHead">{t('regex.customHead')}</div>
      <div className="dsh-tavern-list" style={{ marginBottom: 12 }}>
        {shownRules.map((rule, i) => (
            <RuleEditor
              key={rule.id}
              rule={rule}
              index={i}
              canMoveUp={i > 0}
              canMoveDown={i < current.length - 1}
              onMove={moveRule}
              onChange={updateRule}
              onDelete={removeRule}
            />
          ))}
      </div>
      {shownRules.length < current.length && (
        <div className="dsh-tavern-row" style={{ marginBottom: 8 }}>
          <Btn disabled={busy} onClick={() => setRuleLimit((n) => n + 40)}>{t('common.loadMore')}</Btn>
        </div>
      )}
          {current.length === 0 && (
            <div className="dsh-tavern-regexEmpty">
              <div className="dsh-tavern-emptyTitle">{t('regex.emptyTitle')}</div>
              <div className="dsh-tavern-emptyDesc">{t('regex.emptyDesc')}</div>
            </div>
          )}
          <SaveBar inline>
            <Btn disabled={busy} onClick={() => { setRuleLimit((n) => Math.max(n, current.length + 1)); setRules([...current, newRule()]) }}>{t('regex.new')}</Btn>
            <FileBtn accept=".json" disabled={busy} onFile={(file) => void importRules(file)}>{t('regex.importFile')}</FileBtn>
            {current.length > 0 ? (
              <Btn disabled={busy} onClick={() => downloadJson('tavern-regex-rules.json', current)}>{t('regex.exportAll')}</Btn>
            ) : null}
            <Btn disabled={busy} onClick={() => void save(current)} primary>{t('regex.saveAll')}</Btn>
            <Btn
              disabled={busy}
              onClick={() => {
                if (busy) return
                if (dirty) setConfirmDiscard(true)
                else discardNow()
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
        {presetRegex.state.status === 'error' && <>
          <Err message={presetRegex.state.message} />
          <Btn disabled={busy} onClick={presetRegex.reload}>{t('action.retry')}</Btn>
        </>}
        {presetDrafts !== null && presetDrafts.length === 0 && (
          <Muted>{t('regex.noPresetRegex')}</Muted>
        )}
        {(presetDrafts ?? []).map((preset, pi) => (
          <div className="dsh-tavern-regexPreset" key={preset.editId}>
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
