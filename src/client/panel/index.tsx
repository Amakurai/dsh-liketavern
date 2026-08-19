/** 设置面板入口：7 页签拆分各分区，视觉对齐插件 / Agent 预设。「默认绑定」已并入「设置」页。 */
import { useState } from 'react'
import type { TavernRemote } from '../types.js'
import { Tabs } from '../util.js'
import { CharactersSection } from './characters.js'
import { LorebooksSection } from './lorebooks.js'
import { MemorySection } from './memory.js'
import { PersonasSection } from './personas.js'
import { PresetsSection } from './presets.js'
import { RegexSection } from './regex.js'
import { SettingsSection } from './settings.js'

const TABS = [
  { id: 'characters', label: '角色' },
  { id: 'presets', label: '预设' },
  { id: 'lorebooks', label: '世界书' },
  { id: 'personas', label: '人设' },
  { id: 'regex', label: '正则' },
  { id: 'memory', label: '记忆' },
  { id: 'sampling', label: '设置' },
] as const

type TabId = (typeof TABS)[number]['id']

export function TavernPanel(props: { remote: TavernRemote }) {
  const { remote } = props
  const [tab, setTab] = useState<TabId>('characters')
  return (
    <div className="dsh-tavern-ui dsh-tavern-panel" style={{ width: '100%', maxWidth: '100%', fontSize: 14, boxSizing: 'border-box' }}>
      <Tabs items={[...TABS]} value={tab} onChange={(id) => setTab(id as TabId)} />
      {tab === 'characters' && <CharactersSection remote={remote} />}
      {tab === 'presets' && <PresetsSection remote={remote} />}
      {tab === 'lorebooks' && <LorebooksSection remote={remote} />}
      {tab === 'personas' && <PersonasSection remote={remote} />}
      {tab === 'regex' && <RegexSection remote={remote} />}
      {tab === 'memory' && <MemorySection remote={remote} />}
      {tab === 'sampling' && <SettingsSection remote={remote} />}
    </div>
  )
}
