/** 新会话角色选择：头像、搜索与本次打开应用期间最近使用；资产管理复用原有导入及世界书确认流程。 */
import { useState } from 'react'
import { cachedAvatar } from './cache.js'
import { DraftScope } from './drafts.js'
import { useT } from './i18n.js'
import { CharactersSection } from './panel/characters.js'
import type { CharacterSummary, TavernRemote } from './types.js'
import { Avatar, Badge, Btn, Dialog, Err, SearchEmpty, SearchInput, Skeleton, useLoader } from './util.js'

const recentByRemote = new WeakMap<TavernRemote, string[]>()
export function rememberCharacter(remote: TavernRemote, cardId: string) {
  recentByRemote.set(remote, [cardId, ...(recentByRemote.get(remote) ?? []).filter((id) => id !== cardId)].slice(0, 12))
}

function PickerItem(props: { remote: TavernRemote; item: CharacterSummary; selected: boolean; recent: boolean; busy: boolean; onPick: () => void }) {
  const { item } = props
  const t = useT()
  const avatar = useLoader(() => cachedAvatar(props.remote, item.cardId), [item.cardId], item.hasAvatar)
  return <button type="button" className="dsh-tavern-pickerItem" aria-pressed={props.selected} disabled={props.busy} onClick={props.onPick}>
    <Avatar name={item.name} url={avatar.state.status === 'ready' ? avatar.state.value.dataUrl : null} size={52} />
    <span className="dsh-tavern-pickerText">
      <strong>{item.name}</strong>
      {item.hasCharacterBook && <span>{item.characterBookName || t('hero.picker.embeddedBook')}</span>}
      {props.recent && <span>{t('hero.picker.recent')}</span>}
    </span>
    {props.selected && <Badge accent>{t('hero.picker.selected')}</Badge>}
  </button>
}

export function CharacterPicker(props: { remote: TavernRemote; selectedId?: string; busy: boolean; error: string | null; onPick: (id: string) => void; onClose: () => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(24)
  const [managing, setManaging] = useState(false)
  const chars = useLoader(() => props.remote.listCharacters({}), [managing])
  const items = chars.state.status === 'ready' ? chars.state.value.items : []
  const recent = recentByRemote.get(props.remote) ?? []
  const q = query.trim().toLocaleLowerCase()
  const filtered = items.filter((c) => `${c.name}\n${c.characterBookName ?? ''}`.toLocaleLowerCase().includes(q))
    .sort((a, b) => {
      const rank = (id: string) => { const i = recent.indexOf(id); return i < 0 ? recent.length : i }
      return rank(a.cardId) - rank(b.cardId)
    })
  return <DraftScope>{(request) => <Dialog open width="lg" title={t(managing ? 'section.characters' : 'hero.pickCharacter')}
    onClose={() => { if (!props.busy) request(props.onClose) }}>
    {managing ? <>
      <Btn onClick={() => request(() => setManaging(false))}>{t('hero.picker.back')}</Btn>
      <CharactersSection remote={props.remote} />
    </> : <div className="dsh-tavern-section">
      <div className="dsh-tavern-toolbar">
        <SearchInput label={t('characters.searchLabel')} value={query} width="100%" onChange={(value) => { setQuery(value); setLimit(24) }} />
        <Btn disabled={props.busy} onClick={() => setManaging(true)}>{t('hero.picker.manage')}</Btn>
      </div>
      <Err message={props.error ?? (chars.state.status === 'error' ? chars.state.message : null)} />
      {chars.state.status === 'error' && <Btn onClick={chars.reload}>{t('action.retry')}</Btn>}
      {chars.state.status === 'loading' && <><Skeleton height={84} /><Skeleton height={84} /></>}
      {chars.state.status === 'ready' && items.length === 0 && <div className="dsh-tavern-empty is-compact">
        <div className="dsh-tavern-emptyTitle">{t('hero.noCharacters')}</div>
        <div className="dsh-tavern-emptyDesc">{t('hero.picker.empty')}</div>
        <Btn primary onClick={() => setManaging(true)}>{t('hero.picker.manage')}</Btn>
      </div>}
      {chars.state.status === 'ready' && items.length > 0 && filtered.length === 0 &&
        <SearchEmpty what={t('characters.what')} query={query} onClear={() => setQuery('')} />}
      <div className="dsh-tavern-pickerList" aria-busy={props.busy}>
        {filtered.slice(0, limit).map((item) => <PickerItem key={item.cardId} item={item} remote={props.remote}
          selected={props.selectedId === item.cardId} recent={recent.includes(item.cardId)} busy={props.busy} onPick={() => props.onPick(item.cardId)} />)}
      </div>
      {filtered.length > limit && <Btn onClick={() => setLimit(limit + 24)}>{t('hero.picker.more')}</Btn>}
    </div>}
  </Dialog>}</DraftScope>
}
