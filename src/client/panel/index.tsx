/**
 * 设置面板入口：7 页签拆分各分区。导航是 Tavern 自己的分段控件（pill track），
 * 切页带 fade-up 过场；「默认绑定」已并入「设置」页，设置页内再分子导航。
 */
import { useId, useLayoutEffect, useRef } from 'react'
import { useT } from '../i18n.js'
import type { TavernRemote } from '../types.js'
import { DraftScope } from '../drafts.js'
import { PersistentEditor, useDraftState } from '../draftPersistence.js'
import { Badge, Tabs } from '../util.js'
import { CharactersSection } from './characters.js'
import { LorebooksSection } from './lorebooks.js'
import { MemorySection } from './memory.js'
import { PersonasSection } from './personas.js'
import { PresetsSection } from './presets.js'
import { RegexSection } from './regex.js'
import { SettingsSection } from './settings.js'

const TABS = [
  { id: 'characters', labelKey: 'panel.tab.characters' },
  { id: 'presets', labelKey: 'panel.tab.presets' },
  { id: 'lorebooks', labelKey: 'panel.tab.lorebooks' },
  { id: 'personas', labelKey: 'panel.tab.personas' },
  { id: 'regex', labelKey: 'panel.tab.regex' },
  { id: 'memory', labelKey: 'panel.tab.memory' },
  { id: 'sampling', labelKey: 'panel.tab.settings' },
] as const

type TabId = (typeof TABS)[number]['id']

/** 面板重挂（切走再切回设置页）后停在用户上次看的页签。 */
let lastTab: TabId | undefined

export function TavernPanel(props: { remote: TavernRemote }) {
  return <PersistentEditor remote={props.remote} scope="panel"><PanelContent {...props} /></PersistentEditor>
}

function PanelContent(props: { remote: TavernRemote }) {
  const { remote } = props
  const t = useT()
  const tabsId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useDraftState<TabId>('panel:tab', lastTab ?? 'characters')
  // 手机上的宿主导航可横向滚动，打开面板或缩窄窗口时让当前 Tavern 项保持可见。
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const narrow = window.matchMedia('(max-width:560px)')
    const reveal = () => {
      if (!narrow.matches) return
      panelRef.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>(':scope > nav [aria-current="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    reveal()
    narrow.addEventListener('change', reveal)
    return () => narrow.removeEventListener('change', reveal)
  }, [])
  return (
    <DraftScope>{(request, dirty, busy) => <div ref={panelRef} className="dsh-tavern-ui dsh-tavern-panel" style={{ width: '100%', maxWidth: '100%', fontSize: 14, boxSizing: 'border-box' }}>
      {dirty && <div className="dsh-tavern-draftStatus" role="status"><Badge accent>{t(busy ? 'draft.saving' : 'draft.unsaved')}</Badge></div>}
      <Tabs
        id={tabsId} panelId={`${tabsId}-panel`} label={t('settings.label')}
        items={TABS.map((tab_) => ({ id: tab_.id, label: t(tab_.labelKey) }))}
        value={tab}
        onChange={(id) => { if (id === tab) return; request(() => {
          lastTab = id as TabId
          setTab(id as TabId)
        }) }}
      />
      {/* key=tab 让切页重新挂载并播 fade-up；各页签原本就不跨页保留本地状态 */}
      <div key={tab} id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} tabIndex={0} className="dsh-tavern-rise">
        {tab === 'characters' && <CharactersSection remote={remote} />}
        {tab === 'presets' && <PresetsSection remote={remote} />}
        {tab === 'lorebooks' && <LorebooksSection remote={remote} />}
        {tab === 'personas' && <PersonasSection remote={remote} />}
        {tab === 'regex' && <RegexSection remote={remote} />}
        {tab === 'memory' && <MemorySection remote={remote} />}
        {tab === 'sampling' && <SettingsSection remote={remote} />}
      </div>
    </div>}</DraftScope>
  )
}
