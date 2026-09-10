/**
 * 设置面板分区：二级子导航拆成七组——界面 / 默认配置 / 采样与思考 / 世界书引擎 / 记忆 / 脚本 / 卡片与数据。
 * 每组一个 Section（页面头 + 设置行 + 自己的 SaveBar），一次只看一组，不再一页堆到底。
 * 排版对齐通用设置：标题 + 说明 + 右侧 36px 胶囊控件；瞬时保存反馈走 useToast，上下文错误用 Err。
 * 「界面」组只有语言一项：选择即写设置并 setTavernLocale 立即生效，不走 SaveBar。
 */
import { ScriptSettings } from './scripts.js'
import { CardDataSettings } from './cardData.js'
import { DraftScope, useDraftGuard } from '../drafts.js'
import { useDraftRestored, useDraftState } from '../draftPersistence.js'
import { useEffect, useId, useRef, useState } from 'react'
import { setTavernLocale, useT } from '../i18n.js'
import { EMPTY_SESSION_DEFAULTS, type PresetSummary, type TavernRemote, type TavernSettings } from '../types.js'
import { Btn, CheckChips, Err, Muted, NumInput, SaveBar, Section, Select, SettingsRow, Skeleton, Tabs, Toggle, runAsync, useLoader, useToast } from '../util.js'

const SUBS = [
  { id: 'interface', labelKey: 'settings.sub.interface' },
  { id: 'defaults', labelKey: 'settings.sub.defaults' },
  { id: 'sampling', labelKey: 'settings.sub.sampling' },
  { id: 'worldinfo', labelKey: 'settings.sub.worldinfo' },
  { id: 'memory', labelKey: 'settings.sub.memory' },
  { id: 'scripts', labelKey: 'settings.sub.scripts' },
  { id: 'cards', labelKey: 'settings.sub.cards' },
] as const

type SubId = (typeof SUBS)[number]['id']

/** 切走再切回「设置」页签后停在用户上次看的子组。 */
let lastSub: SubId | undefined

export function SettingsSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const t = useT()
  const tabsId = useId()
  const { state, reload } = useLoader(() => remote.getSettings({}), [])
  const dataInfo = useLoader(() => remote.getDataInfo({}), [])
  const presets = useLoader(() => remote.listPresets({}), [])
  const lore = useLoader(() => remote.listLorebooks({}), [])
  const personas = useLoader(() => remote.listPersonas({}), [])
  const [sub, setSub] = useDraftState<SubId>('settings:sub', lastSub ?? 'interface')
  const [baseline, setBaseline] = useDraftState<TavernSettings | null>('settings:baseline', null)
  const [draft, setDraft] = useDraftState<TavernSettings | null>('settings:draft', null)
  const restoredDraft = useDraftRestored('settings:draft')
  const restoredBaseline = useDraftRestored('settings:baseline')
  const receivedSettings = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  useDraftGuard(draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline), busy)

  /** 老配置可能缺 defaults 键，落成草稿时按 EMPTY_SESSION_DEFAULTS 补齐。 */
  const toDraft = (settings: TavernSettings): TavernSettings => ({
    ...structuredClone(settings),
    defaults: { ...EMPTY_SESSION_DEFAULTS, ...settings.defaults },
    worldInfo: { ...settings.worldInfo, useGroupScoring: settings.worldInfo.useGroupScoring ?? false },
  })

  useEffect(() => {
    if (state.status !== 'ready') return
    const firstReady = !receivedSettings.current
    receivedSettings.current = true
    // 首次远端读取只补没有恢复的字段；null 表示尚未初始化，不应让加载中的快照锁死页面。
    if (!firstReady || !restoredDraft || draft === null) setDraft(toDraft(state.value.settings))
    if (!firstReady || !restoredBaseline || baseline === null) setBaseline(toDraft(state.value.settings))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const save = (patch: Record<string, unknown>, toastText: string) =>
    runAsync(setBusy, setError, async () => {
      const r = await remote.updateSettings({ patch })
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      const saved = toDraft(r.value.settings)
      setBaseline(saved)
      // 保存区接收服务器结果；其它区只保留实际编辑的草稿，未编辑字段同步最新值，避免凭空产生脏状态。
      setDraft((current) => {
        if (!current) return saved
        const next = { ...saved }
        for (const key of Object.keys(current) as Array<keyof TavernSettings>) {
          if (!Object.hasOwn(patch, key) && JSON.stringify(current[key]) !== JSON.stringify(baseline?.[key])) {
            ;(next as unknown as Record<string, unknown>)[key] = structuredClone(current[key])
          }
        }
        return next
      })
      toast.show(toastText)
    })

  /** 语言切换：先本地生效再持久化；保存失败回退界面语言并提示。 */
  const changeLocale = (locale: 'auto' | 'en' | 'zh') => {
    if (!draft || locale === draft.locale) return
    const prev = draft.locale
    setDraft({ ...draft, locale })
    setTavernLocale(locale)
    void runAsync(setBusy, setError, async () => {
      try {
        const r = await remote.updateSettings({ patch: { locale } })
        if (!r.ok) throw new Error(r.error.message)
        const savedLocale = r.value.settings.locale
        setBaseline((current) => current ? { ...current, locale: savedLocale } : current)
        setDraft((current) => current ? { ...current, locale: savedLocale } : current)
        setTavernLocale(savedLocale)
      } catch (error) {
        setDraft((current) => (current ? { ...current, locale: prev } : current))
        setTavernLocale(prev)
        throw new Error(`${t('settings.interface.languageFailed')}: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  if (state.status === 'loading')
    return (
      <Section title={t('settings.title')}>
        <Skeleton height={56} />
        <Skeleton height={56} />
        <Skeleton height={56} />
      </Section>
    )
  if (state.status === 'error')
    return (
      <Section title={t('settings.title')}>
        <Err message={state.message} />
        <Btn size="md" onClick={reload}>
          {t('action.retry')}
        </Btn>
      </Section>
    )
  if (!draft) return null

  const presetItems: PresetSummary[] = presets.state.status === 'ready' ? presets.state.value.items : []
  const lorebooks = lore.state.status === 'ready' ? lore.state.value.items : []
  const personaItems = personas.state.status === 'ready' ? personas.state.value.items : []

  const setSampling = (patch: Partial<TavernSettings['sampling']>) => setDraft({ ...draft, sampling: { ...draft.sampling, ...patch } })
  const setWorldInfo = (patch: Partial<TavernSettings['worldInfo']>) => setDraft({ ...draft, worldInfo: { ...draft.worldInfo, ...patch } })
  const setMemory = (patch: Partial<TavernSettings['memory']>) => setDraft({ ...draft, memory: { ...draft.memory, ...patch } })
  const setDefaults = (patch: Partial<TavernSettings['defaults']>) => setDraft({ ...draft, defaults: { ...draft.defaults, ...patch } })

  return (
    <>
      {toast.node}
      <fieldset disabled={busy} className="dsh-tavern-editorFields">
      {/* 设置草稿挂在本组件上，切子组不会丢，因此本组件的守卫只向面板级作用域汇报；
          这里的内层作用域只保护子组内随切换卸载的嵌套编辑器（脚本库、卡片数据），不会为设置自身的草稿弹放弃确认。 */}
      <DraftScope>{(request) => <>
      <Tabs
        id={tabsId} panelId={`${tabsId}-panel`} label={t('settings.title')}
        items={SUBS.map((s) => ({ id: s.id, label: t(s.labelKey) }))}
        value={sub}
        onChange={(id) => {
          if (id === sub) return
          request(() => {
            lastSub = id as SubId
            setSub(id as SubId)
          })
        }}
      />
      {/* key=sub 让切组重新挂载并播 fade-up */}
      <div key={sub} id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${sub}`} tabIndex={0} className="dsh-tavern-rise">
        {sub === 'scripts' && <ScriptSettings remote={remote}/>}
        {sub === 'interface' && (
          <Section title={t('settings.interface.title')} description={t('settings.interface.desc')}>
            <SettingsRow title={t('settings.interface.language')} description={t('settings.interface.languageDesc')}>
              {/* 中/英选项用各自语言自描述（宿主 locale 插件同款约定），auto 档随界面语言翻译。 */}
              <Select
                size="md"
                value={draft.locale}
                onChange={(v) => changeLocale(v === 'zh' ? 'zh' : v === 'en' ? 'en' : 'auto')}
                options={[
                  { value: 'auto', label: t('settings.interface.localeAuto') },
                  { value: 'en', label: 'English' },
                  { value: 'zh', label: '中文' },
                ]}
              />
            </SettingsRow>
          </Section>
        )}

        {sub === 'defaults' && (
          <Section title={t('settings.defaults.title')} description={t('settings.defaults.desc')}>
            <SettingsRow title={t('settings.defaults.preset')} description={t('settings.defaults.presetDesc')}>
              <Select
                size="md"
                value={draft.defaults.presetId}
                onChange={(presetId) => setDefaults({ presetId })}
                options={[
                  { value: '', label: t('settings.defaults.builtinPreset') },
                  ...presetItems.map((p) => ({
                    value: p.id,
                    label: p.regexCount > 0 ? t('settings.defaults.presetRegexCount', { name: p.name, count: p.regexCount }) : p.name,
                  })),
                ]}
              />
            </SettingsRow>
            <SettingsRow title={t('settings.defaults.persona')} description={t('settings.defaults.personaDesc')}>
              <Select
                size="md"
                value={draft.defaults.personaId}
                onChange={(personaId) => setDefaults({ personaId })}
                options={[{ value: '', label: t('settings.defaults.noPersona') }, ...personaItems.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </SettingsRow>
            <SettingsRow title={t('settings.defaults.mainLore')} description={t('settings.defaults.mainLoreDesc')}>
              <Select
                size="md"
                value={draft.defaults.characterLorebookId}
                onChange={(characterLorebookId) => setDefaults({ characterLorebookId })}
                options={[{ value: '', label: t('settings.defaults.embeddedLore') }, ...lorebooks.map((n) => ({ value: n, label: n }))]}
              />
            </SettingsRow>
            <SettingsRow title={t('settings.defaults.globalLore')} description={t('settings.defaults.globalLoreDesc')} stacked>
              {lorebooks.length === 0 ? (
                <Muted>{t('settings.defaults.noLorebooks')}</Muted>
              ) : (
                <CheckChips
                  ariaLabel={t('settings.defaults.globalLore')}
                  options={lorebooks.map((n) => ({ value: n, label: n }))}
                  selected={draft.defaults.lorebookIds}
                  onChange={(lorebookIds) => setDefaults({ lorebookIds })}
                />
              )}
            </SettingsRow>
            <SaveBar>
              <Btn primary size="md" disabled={busy} onClick={() => void save({ defaults: draft.defaults }, t('settings.defaults.saved'))}>
                {t('settings.defaults.save')}
              </Btn>
            </SaveBar>
          </Section>
        )}

        {sub === 'sampling' && (
          <Section title={t('settings.sampling.title')} description={t('settings.sampling.desc')}>
            <SettingsRow title="temperature" description={t('settings.sampling.temperatureDesc')}>
              <NumInput step="0.05" value={draft.sampling.temperature} onChange={(v) => setSampling({ temperature: v })} />
            </SettingsRow>
            <SettingsRow title="topP" description={t('settings.sampling.topPDesc')}>
              <NumInput step="0.05" value={draft.sampling.topP} onChange={(v) => setSampling({ topP: v })} />
            </SettingsRow>
            <SettingsRow title="maxTokens" description={t('settings.sampling.maxTokensDesc')}>
              <NumInput value={draft.sampling.maxTokens} onChange={(v) => setSampling({ maxTokens: Math.max(0, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title="presencePenalty">
              <NumInput step="0.1" value={draft.sampling.presencePenalty} onChange={(v) => setSampling({ presencePenalty: v })} />
            </SettingsRow>
            <SettingsRow title="frequencyPenalty">
              <NumInput step="0.1" value={draft.sampling.frequencyPenalty} onChange={(v) => setSampling({ frequencyPenalty: v })} />
            </SettingsRow>
            <SettingsRow title={t('settings.sampling.thinking')} description={t('settings.sampling.thinkingDesc')}>
              <Select
                size="md"
                value={draft.sampling.thinking}
                onChange={(v) => setSampling({ thinking: v as TavernSettings['sampling']['thinking'] })}
                options={[
                  { value: 'disabled', label: t('settings.sampling.thinking.disabled') },
                  { value: 'enabled', label: t('settings.sampling.thinking.enabled') },
                  { value: 'low', label: t('settings.sampling.thinking.low') },
                  { value: 'high', label: t('settings.sampling.thinking.high') },
                  { value: 'max', label: t('settings.sampling.thinking.max') },
                ]}
              />
            </SettingsRow>
            <SettingsRow title={t('settings.sampling.stop')} description={t('settings.sampling.stopDesc')} stacked>
              <textarea
                className="dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont"
                style={{ minHeight: 64 }}
                value={draft.sampling.stop.join('\n')}
                onChange={(e) => setSampling({ stop: e.target.value.split('\n').map((s: string) => s.trim()).filter(Boolean) })}
              />
            </SettingsRow>
            <SaveBar>
              <Btn disabled={busy} onClick={() => void save({ sampling: draft.sampling }, t('settings.sampling.saved'))} primary size="md">
                {t('settings.sampling.save')}
              </Btn>
            </SaveBar>
          </Section>
        )}

        {sub === 'worldinfo' && (
          <Section title={t('settings.worldinfo.title')} description={t('settings.worldinfo.desc')}>
            <SettingsRow title={t('settings.worldinfo.scanDepth')}>
              <NumInput value={draft.worldInfo.scanDepth} onChange={(v) => setWorldInfo({ scanDepth: Math.max(0, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.worldinfo.minActivations')} description={t('settings.worldinfo.minActivationsDesc')}>
              <NumInput value={draft.worldInfo.minActivations ?? 0} onChange={v=>setWorldInfo({minActivations:Math.min(2000,Math.max(0,Math.round(v)))})}/>
            </SettingsRow>
            <SettingsRow title={t('settings.worldinfo.maxScanDepth')} description={t('settings.worldinfo.maxScanDepthDesc')}>
              <NumInput value={draft.worldInfo.maxScanDepth ?? 0} onChange={v=>setWorldInfo({maxScanDepth:Math.min(1000,Math.max(0,Math.round(v)))})}/>
            </SettingsRow>
            <SettingsRow title={t('settings.worldinfo.contextPercent')} description={t('settings.worldinfo.contextPercentDesc')}>
              <NumInput value={draft.worldInfo.contextPercent} onChange={(v) => setWorldInfo({ contextPercent: v })} />
            </SettingsRow>
            <SettingsRow title={t('settings.worldinfo.tokenBudget')} description={t('settings.worldinfo.tokenBudgetDesc')}>
              <NumInput value={draft.worldInfo.tokenBudget} onChange={(v) => setWorldInfo({ tokenBudget: Math.max(0, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.worldinfo.maxRecursionSteps')} description={t('settings.worldinfo.maxRecursionStepsDesc')}>
              <NumInput value={draft.worldInfo.maxRecursionSteps} onChange={(v) => setWorldInfo({ maxRecursionSteps: Math.max(0, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.worldinfo.strategy')}>
              <Select
                size="md"
                value={String(draft.worldInfo.characterStrategy)}
                onChange={(v) => setWorldInfo({ characterStrategy: Number(v) as 0 | 1 | 2 })}
                options={[
                  { value: '0', label: 'Sorted Evenly' },
                  { value: '1', label: 'Character Lore First' },
                  { value: '2', label: 'Global Lore First' },
                ]}
              />
            </SettingsRow>
            {(
              [
                ['recursiveScan', 'settings.worldinfo.recursiveScan', 'settings.worldinfo.recursiveScanDesc'],
                ['caseSensitive', 'settings.worldinfo.caseSensitive', ''],
                ['matchWholeWords', 'settings.worldinfo.matchWholeWords', 'settings.worldinfo.matchWholeWordsDesc'],
                ['includeNames', 'settings.worldinfo.includeNames', ''],
                ['overflowWarning', 'settings.worldinfo.overflowWarning', ''],
                ['useGroupScoring', 'settings.worldinfo.useGroupScoring', 'settings.worldinfo.useGroupScoringDesc'],
              ] as const
            ).map(([key, titleKey, descKey]) => (
              <SettingsRow key={key} title={t(titleKey)} description={descKey ? t(descKey) : undefined}>
                <Toggle checked={draft.worldInfo[key]} onChange={(on) => setWorldInfo({ [key]: on } as Partial<TavernSettings['worldInfo']>)} />
              </SettingsRow>
            ))}
            <SaveBar>
              <Btn disabled={busy} onClick={() => void save({ worldInfo: draft.worldInfo }, t('settings.worldinfo.saved'))} primary size="md">
                {t('settings.worldinfo.save')}
              </Btn>
            </SaveBar>
          </Section>
        )}

        {sub === 'memory' && (
          <Section title={t('settings.memory.title')} description={t('settings.memory.desc')}>
            <SettingsRow title={t('settings.memory.maxEntries')} description={t('settings.memory.maxEntriesDesc')}>
              <NumInput value={draft.memory.maxEntries} onChange={(v) => setMemory({ maxEntries: Math.max(1, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.memory.maxTokens')} description={t('settings.memory.maxTokensDesc')}>
              <NumInput value={draft.memory.maxTokens} onChange={(v) => setMemory({ maxTokens: Math.max(0, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.memory.retrievalTopK')} description={t('settings.memory.retrievalTopKDesc')}>
              <NumInput value={draft.memory.retrievalTopK} onChange={(v) => setMemory({ retrievalTopK: Math.max(0, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.memory.retrievalTokenBudget')} description={t('settings.memory.retrievalTokenBudgetDesc')}>
              <NumInput value={draft.memory.retrievalTokenBudget} onChange={(v) => setMemory({ retrievalTokenBudget: Math.max(0, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.memory.halfLifeDays')} description={t('settings.memory.halfLifeDaysDesc')}>
              <NumInput value={draft.memory.halfLifeDays} onChange={(v) => setMemory({ halfLifeDays: Math.max(0, v) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.memory.dedupScore')} description={t('settings.memory.dedupScoreDesc')}>
              <NumInput value={draft.memory.dedupScore} onChange={(v) => setMemory({ dedupScore: Math.max(0, v) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.memory.compressBatch')} description={t('settings.memory.compressBatchDesc')}>
              <NumInput value={draft.memory.compressBatch} onChange={(v) => setMemory({ compressBatch: Math.max(2, Math.round(v)) })} />
            </SettingsRow>
            <SettingsRow title={t('settings.memory.queryMessages')} description={t('settings.memory.queryMessagesDesc')}>
              <NumInput value={draft.memory.queryMessages} onChange={(v) => setMemory({ queryMessages: Math.max(1, Math.round(v)) })} />
            </SettingsRow>
            <SaveBar>
              <Btn disabled={busy} onClick={() => void save({ memory: draft.memory }, t('settings.memory.saved'))} primary size="md">
                {t('settings.memory.save')}
              </Btn>
            </SaveBar>
          </Section>
        )}

        {sub === 'cards' && (
          <>
            <Section title={t('settings.cards.title')} description={t('settings.cards.desc')}>
              <SettingsRow title={t('settings.cards.cascadeDelete')} description={t('settings.cards.cascadeDeleteDesc')}>
                <Toggle checked={draft.cascadeDeleteEmbeddedBook} onChange={(cascadeDeleteEmbeddedBook) => setDraft({ ...draft, cascadeDeleteEmbeddedBook })} />
              </SettingsRow>
              <SettingsRow title={t('settings.cards.interactiveCards')} description={t('settings.cards.interactiveCardsDesc')}>
                <Toggle checked={draft.interactiveCards} onChange={(interactiveCards) => setDraft({ ...draft, interactiveCards })} />
              </SettingsRow>
              <SettingsRow title={t('settings.cards.triggerLogMax')}>
                <NumInput value={draft.triggerLogMax} onChange={(v) => setDraft({ ...draft, triggerLogMax: Math.max(10, Math.round(v)) })} />
              </SettingsRow>
              <SettingsRow title={t('settings.cards.whitelist')} description={t('settings.cards.whitelistDesc')} stacked>
                <textarea
                  className="dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont"
                  style={{ minHeight: 64 }}
                  value={draft.cardNetworkWhitelist.join('\n')}
                  onChange={(e) =>
                    setDraft({ ...draft, cardNetworkWhitelist: e.target.value.split('\n').map((s: string) => s.trim()).filter(Boolean) })
                  }
                />
              </SettingsRow>
              <SaveBar>
                <Btn
                  primary
                  size="md"
                  disabled={busy}
                  onClick={() =>
                    void save(
                      {
                        cascadeDeleteEmbeddedBook: draft.cascadeDeleteEmbeddedBook,
                        interactiveCards: draft.interactiveCards,
                        triggerLogMax: draft.triggerLogMax,
                        cardNetworkWhitelist: draft.cardNetworkWhitelist,
                      },
                      t('settings.cards.saved'),
                    )
                  }
                >
                  {t('settings.cards.save')}
                </Btn>
              </SaveBar>
            </Section>
            <CardDataSettings remote={remote} />
            <div className="dsh-tavern-groupHead">{t('settings.cards.dataHome')}</div>
            <Muted>
              <span style={{ wordBreak: 'break-all' }}>
                {t('settings.cards.dataHomeDesc')}
                {dataInfo.state.status === 'ready' ? dataInfo.state.value.dataHome : '…'}
              </span>
            </Muted>
          </>
        )}
      </div>
      </>}</DraftScope>

      <Err message={error} />
      </fieldset>
    </>
  )
}
