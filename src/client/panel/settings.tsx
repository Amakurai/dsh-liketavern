/**
 * 设置面板分区：顶部「选卡后的默认配置」+ 采样参数 / 世界书全局 / 交互卡。
 * 排版对齐通用设置：标题 + 说明 + 右侧 36px 胶囊控件；瞬时保存反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react'
import { EMPTY_SESSION_DEFAULTS, type PresetSummary, type TavernRemote, type TavernSettings } from '../types.js'
import { Btn, Err, Muted, NumInput, Section, Select, SettingsRow, Skeleton, Toggle, textarea, useLoader, useToast } from '../util.js'

export function SettingsSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.getSettings({}), [])
  const presets = useLoader(() => remote.listPresets({}), [])
  const lore = useLoader(() => remote.listLorebooks({}), [])
  const personas = useLoader(() => remote.listPersonas({}), [])
  const [draft, setDraft] = useState<TavernSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()

  /** 老配置可能缺 defaults 键，落成草稿时按 EMPTY_SESSION_DEFAULTS 补齐。 */
  const toDraft = (settings: TavernSettings): TavernSettings => ({
    ...structuredClone(settings),
    defaults: { ...EMPTY_SESSION_DEFAULTS, ...settings.defaults },
    worldInfo: { ...settings.worldInfo, useGroupScoring: settings.worldInfo.useGroupScoring ?? false },
  })

  useEffect(() => {
    if (state.status === 'ready') setDraft(toDraft(state.value.settings))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const save = async (patch: Record<string, unknown>, toastText: string) => {
    setBusy(true)
    setError(null)
    const r = await remote.updateSettings({ patch })
    setBusy(false)
    if (!r.ok) setError(r.error.message)
    else {
      const saved = toDraft(r.value.settings)
      // 一页有多个独立保存区：只用服务端返回值刷新本次保存的键，保留其它区尚未保存的草稿。
      setDraft((current) => {
        if (!current) return saved
        const next = { ...current }
        for (const key of Object.keys(patch) as Array<keyof TavernSettings>) {
          ;(next as unknown as Record<string, unknown>)[key] = structuredClone(saved[key])
        }
        return next
      })
      toast.show(toastText)
    }
  }

  if (state.status === 'loading')
    return (
      <Section title="设置">
        <Skeleton height={56} />
        <Skeleton height={56} />
        <Skeleton height={56} />
      </Section>
    )
  if (state.status === 'error')
    return (
      <Section title="设置">
        <Err message={state.message} />
        <Btn size="md" onClick={reload}>
          重试
        </Btn>
      </Section>
    )
  if (!draft) return null

  const presetItems: PresetSummary[] = presets.state.status === 'ready' ? presets.state.value.items : []
  const lorebooks = lore.state.status === 'ready' ? lore.state.value.items : []
  const personaItems = personas.state.status === 'ready' ? personas.state.value.items : []
  const embeddedLabel = '（使用所选角色的卡内嵌书 / 无）'

  const setSampling = (patch: Partial<TavernSettings['sampling']>) => setDraft({ ...draft, sampling: { ...draft.sampling, ...patch } })
  const setWorldInfo = (patch: Partial<TavernSettings['worldInfo']>) => setDraft({ ...draft, worldInfo: { ...draft.worldInfo, ...patch } })
  const setMemory = (patch: Partial<TavernSettings['memory']>) => setDraft({ ...draft, memory: { ...draft.memory, ...patch } })
  const setDefaults = (patch: Partial<TavernSettings['defaults']>) => setDraft({ ...draft, defaults: { ...draft.defaults, ...patch } })

  return (
    <>
      {toast.node}
      <Section title="选卡后的默认配置" description="在新对话里点选任意角色卡后，会套用这里的预设、世界书与人设。新对话不会自动选角色；已打开的会话请用对话页角色芯片修改。">
        <SettingsRow title="提示词预设" description="当前会话请用对话页角色芯片切换。这里只影响之后点选角色时的默认值。">
          <Select
            size="md"
            value={draft.defaults.presetId}
            onChange={(presetId) => setDefaults({ presetId })}
            options={[
              { value: '', label: '（内建默认预设）' },
              ...presetItems.map((p) => ({ value: p.id, label: p.regexCount > 0 ? `${p.name}（${p.regexCount} 条正则）` : p.name })),
            ]}
          />
        </SettingsRow>
        <SettingsRow title="人设" description="用户侧名字（{{user}}）。可空；若库里只有一条人设，未选择时也会自动用那条。">
          <Select
            size="md"
            value={draft.defaults.personaId}
            onChange={(personaId) => setDefaults({ personaId })}
            options={[{ value: '', label: '（无人设）' }, ...personaItems.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </SettingsRow>
        <SettingsRow title="主世界书" description="Character Lore。不选则使用角色卡内嵌世界书（若导入时保留了）。">
          <Select
            size="md"
            value={draft.defaults.characterLorebookId}
            onChange={(characterLorebookId) => setDefaults({ characterLorebookId })}
            options={[{ value: '', label: embeddedLabel }, ...lorebooks.map((n) => ({ value: n, label: n }))]}
          />
        </SettingsRow>
        <SettingsRow title="全局世界书" description="可多选，每轮检索时与主世界书一并扫描。" stacked>
          {lorebooks.length === 0 ? (
            <Muted>库中暂无独立世界书。可在「世界书」页导入，或使用角色卡内嵌书。</Muted>
          ) : (
            <div className="dsh-tavern-checkList">
              {lorebooks.map((n) => (
                <label key={n}>
                  <input
                    type="checkbox"
                    checked={draft.defaults.lorebookIds.includes(n)}
                    onChange={(e) =>
                      setDefaults({
                        lorebookIds: e.target.checked ? [...draft.defaults.lorebookIds, n] : draft.defaults.lorebookIds.filter((x) => x !== n),
                      })
                    }
                  />
                  {n}
                </label>
              ))}
            </div>
          )}
        </SettingsRow>
        <div style={{ padding: '12px 0 4px' }}>
          <Btn primary size="md" disabled={busy} onClick={() => void save({ defaults: draft.defaults }, '已保存选卡后的默认配置')}>
            保存默认配置
          </Btn>
        </div>
      </Section>

      <div className="dsh-tavern-groupHead">角色卡</div>
      <Section title="角色卡" description="删除角色卡时的连带行为。">
        <SettingsRow title="连同删除内嵌世界书" description="开启：删除角色卡时其内嵌世界书一并删除。关闭：删卡前把内嵌书保留到世界书库（重名自动加序号）。">
          <Toggle checked={draft.cascadeDeleteEmbeddedBook} onChange={(cascadeDeleteEmbeddedBook) => setDraft({ ...draft, cascadeDeleteEmbeddedBook })} />
        </SettingsRow>
        <div style={{ padding: '12px 0 4px' }}>
          <Btn primary size="md" disabled={busy} onClick={() => void save({ cascadeDeleteEmbeddedBook: draft.cascadeDeleteEmbeddedBook }, '已保存角色卡设置')}>
            保存角色卡设置
          </Btn>
        </div>
      </Section>

      <div className="dsh-tavern-groupHead">采样与行为</div>
      <Section title="采样参数" description="temperature / maxTokens / stop 会透传到模型；topP 与 penalty 当前平台不生效，仅作记录。">
        <SettingsRow title="temperature" description="0–2，默认 1。thinking 模式下不生效。">
          <NumInput step="0.05" value={draft.sampling.temperature} onChange={(v) => setSampling({ temperature: v })} />
        </SettingsRow>
        <SettingsRow title="topP" description="0–1。当前 dsh 模型服务不透传。">
          <NumInput step="0.05" value={draft.sampling.topP} onChange={(v) => setSampling({ topP: v })} />
        </SettingsRow>
        <SettingsRow title="maxTokens" description="单次生成最大 token；0 = 沿用模型默认。">
          <NumInput value={draft.sampling.maxTokens} onChange={(v) => setSampling({ maxTokens: Math.max(0, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="presencePenalty">
          <NumInput step="0.1" value={draft.sampling.presencePenalty} onChange={(v) => setSampling({ presencePenalty: v })} />
        </SettingsRow>
        <SettingsRow title="frequencyPenalty">
          <NumInput step="0.1" value={draft.sampling.frequencyPenalty} onChange={(v) => setSampling({ frequencyPenalty: v })} />
        </SettingsRow>
        <SettingsRow title="深度思考" description="关闭：对当前模型写入 off（若公布该档）。开启：保留会话已选档位，否则用模型默认。部署把 thinking 锁成 disabled 时无法打开。thinking 模式下温度不生效。">
          <Toggle
            checked={draft.sampling.thinking === 'enabled'}
            onChange={(on) => setSampling({ thinking: on ? 'enabled' : 'disabled' })}
            title="启用 thinking"
          />
        </SettingsRow>
        <SettingsRow title="停止序列" description="每行一个。" stacked>
          <textarea
            style={{ ...textarea, minHeight: 64 }}
            value={draft.sampling.stop.join('\n')}
            onChange={(e) => setSampling({ stop: e.target.value.split('\n').map((s: string) => s.trim()).filter(Boolean) })}
          />
        </SettingsRow>
        <div style={{ padding: '12px 0 4px' }}>
          <Btn disabled={busy} onClick={() => void save({ sampling: draft.sampling }, '已保存采样参数')} primary size="md">
            保存采样参数
          </Btn>
        </div>
      </Section>

      <div className="dsh-tavern-groupHead">世界书全局</div>
      <Section title="世界书全局设置" description="扫描深度、预算与合并策略，对所有会话生效。">
        <SettingsRow title="扫描深度 scanDepth">
          <NumInput value={draft.worldInfo.scanDepth} onChange={(v) => setWorldInfo({ scanDepth: Math.max(0, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="预算百分比 contextPercent">
          <NumInput value={draft.worldInfo.contextPercent} onChange={(v) => setWorldInfo({ contextPercent: v })} />
        </SettingsRow>
        <SettingsRow title="固定 token 预算">
          <NumInput value={draft.worldInfo.tokenBudget} onChange={(v) => setWorldInfo({ tokenBudget: Math.max(0, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="最大递归步数">
          <NumInput value={draft.worldInfo.maxRecursionSteps} onChange={(v) => setWorldInfo({ maxRecursionSteps: Math.max(0, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="合并策略">
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
            ['recursiveScan', '递归扫描', '命中条目的内容继续作为关键词扫描。'],
            ['caseSensitive', '区分大小写', ''],
            ['matchWholeWords', '整词匹配', '对中文不友好，建议关闭。'],
            ['includeNames', '扫描计入消息名前缀', ''],
            ['overflowWarning', '预算溢出告警', ''],
            ['useGroupScoring', '组内按命中键数挑选', '开启后同组按命中关键词数选一条；关闭则按组权重随机。'],
          ] as const
        ).map(([key, title, description]) => (
          <SettingsRow key={key} title={title} description={description || undefined}>
            <Toggle checked={draft.worldInfo[key]} onChange={(on) => setWorldInfo({ [key]: on } as Partial<TavernSettings['worldInfo']>)} />
          </SettingsRow>
        ))}
        <div style={{ padding: '12px 0 4px' }}>
          <Btn disabled={busy} onClick={() => void save({ worldInfo: draft.worldInfo }, '已保存世界书设置')} primary size="md">
            保存世界书设置
          </Btn>
        </div>
      </Section>

      <div className="dsh-tavern-groupHead">记忆</div>
      <Section title="记忆设置" description="BM25 长期记忆的容量、检索与压缩参数，对所有角色生效。">
        <SettingsRow title="条数上限 maxEntries" description="每角色记忆条数上限，超出后在 turn 结束空闲时异步压缩最旧批次。最小 1。">
          <NumInput value={draft.memory.maxEntries} onChange={(v) => setMemory({ maxEntries: Math.max(1, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="token 上限 maxTokens" description="每角色记忆的估算 token 上限，超出同样触发压缩。">
          <NumInput value={draft.memory.maxTokens} onChange={(v) => setMemory({ maxTokens: Math.max(0, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="检索条数 retrievalTopK" description="每轮 BM25 检索注入 runtime context 的记忆条数；0 = 不注入。">
          <NumInput value={draft.memory.retrievalTopK} onChange={(v) => setMemory({ retrievalTopK: Math.max(0, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="检索预算 retrievalTokenBudget" description="每轮检索注入的估算 token 预算。">
          <NumInput value={draft.memory.retrievalTokenBudget} onChange={(v) => setMemory({ retrievalTokenBudget: Math.max(0, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="时间衰减半衰期（天）" description="检索打分时旧记忆按半衰期降权；0 = 不衰减。">
          <NumInput value={draft.memory.halfLifeDays} onChange={(v) => setMemory({ halfLifeDays: Math.max(0, v) })} />
        </SettingsRow>
        <SettingsRow title="去重阈值 dedupScore" description="写入记忆的相似度阈值（BM25 分），达到则视为重复不写入；越高越不容易判重。">
          <NumInput value={draft.memory.dedupScore} onChange={(v) => setMemory({ dedupScore: Math.max(0, v) })} />
        </SettingsRow>
        <SettingsRow title="压缩批次 compressBatch" description="每次压缩合并的最旧条数。最小 2。">
          <NumInput value={draft.memory.compressBatch} onChange={(v) => setMemory({ compressBatch: Math.max(2, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow title="检索取词 queryMessages" description="BM25 检索的 query 取最近 N 条消息。最小 1。">
          <NumInput value={draft.memory.queryMessages} onChange={(v) => setMemory({ queryMessages: Math.max(1, Math.round(v)) })} />
        </SettingsRow>
        <div style={{ padding: '12px 0 4px' }}>
          <Btn disabled={busy} onClick={() => void save({ memory: draft.memory }, '已保存记忆设置')} primary size="md">
            保存记忆设置
          </Btn>
        </div>
      </Section>

      <div className="dsh-tavern-groupHead">交互卡</div>
      <Section title="交互卡" description="封面 HTML 默认允许加载 https 图片与字体。卡内切开场白走宿主 swipe，不开放主窗口 API。">
        <SettingsRow title="交互卡渲染" description="关闭后封面与交互卡一律按纯文本显示。">
          <Toggle checked={draft.interactiveCards} onChange={(interactiveCards) => setDraft({ ...draft, interactiveCards })} />
        </SettingsRow>
        <SettingsRow title="触发日志保留条数">
          <NumInput value={draft.triggerLogMax} onChange={(v) => setDraft({ ...draft, triggerLogMax: Math.max(10, Math.round(v)) })} />
        </SettingsRow>
        <SettingsRow
          title="脚本信任的外部域名"
          description="封面脚本默认不能 fetch/XHR、也不能加载外部脚本；按行填写域名逐个放行，单独一行 * 表示全部放行。图片和字体默认已放行 https。"
          stacked
        >
          <textarea
            style={{ ...textarea, minHeight: 64 }}
            value={draft.cardNetworkWhitelist.join('\n')}
            onChange={(e) =>
              setDraft({ ...draft, cardNetworkWhitelist: e.target.value.split('\n').map((s: string) => s.trim()).filter(Boolean) })
            }
          />
        </SettingsRow>
        <div style={{ padding: '12px 0 4px' }}>
          <Btn
            primary
            size="md"
            disabled={busy}
            onClick={() =>
              void save(
                {
                  interactiveCards: draft.interactiveCards,
                  triggerLogMax: draft.triggerLogMax,
                  cardNetworkWhitelist: draft.cardNetworkWhitelist,
                },
                '已保存交互卡设置',
              )
            }
          >
            保存交互卡设置
          </Btn>
        </div>
      </Section>

      <Err message={error} />
    </>
  )
}
