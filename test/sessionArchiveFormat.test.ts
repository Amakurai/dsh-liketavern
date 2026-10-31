/** 单会话迁移格式校验：真实宿主事件、剧情归属、跨平台路径与文件摘要的失败边界。 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { archiveFile, parseSessionArchive, sealSessionArchive } from '../src/node/sessionArchiveFormat.js'

function fixture() {
  const ctx = new Context()
  new SessionStore(ctx)
  const session = ctx.sessions.create(SessionId('session-test'))
  session.append('agent-preset/selected', { agentPreset: 'tavern' })
  const storyId = 'story-00000000-0000-4000-8000-000000000001'
  return sealSessionArchive({ format: 'dsh-tavern-session', version: 1,
    binding: { sessionId: session.id, cardId: 'test-card', storyId, presetId: null, personaId: null,
      lorebookIds: [], characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() },
    session: { header: session.header, inheritedEventCount: 0, events: session.snapshotEvents() },
    attachments: [], files: [archiveFile('card', 'card.json', Buffer.from('{"name":"test"}')),
      archiveFile('story', 'story.json', Buffer.from(JSON.stringify({ version: 1, id: storyId, sessionId: session.id, createdAt: new Date(0).toISOString(), migrated: false }))),
      archiveFile('story', 'memory/fact.md', Buffer.from('保留记忆')), archiveFile('story', 'state/wal/1.jsonl', Buffer.from('历史 WAL'))] })
}

describe('单会话迁移文件', () => {
  it('保留宿主事件、剧情记忆与 WAL 的精确字节', () => {
    const input = fixture(), parsed = parseSessionArchive(JSON.parse(JSON.stringify(input)))
    expect(parsed.session.events).toEqual(input.session.events)
    expect(Buffer.from(parsed.files.find(file => file.path === 'memory/fact.md')!.data, 'base64').toString()).toBe('保留记忆')
    expect(Buffer.from(parsed.files.find(file => file.path === 'state/wal/1.jsonl')!.data, 'base64').toString()).toBe('历史 WAL')
  })
  it('源工作区是另一平台路径时仍能校验，原路径由导入时的目标工作区替换', () => {
    const input = fixture()
    const foreignCwd = process.platform === 'win32' ? '/srv/old-workspace' : 'C:\\old-workspace'
    const sealed = sealSessionArchive({ ...input, session: { ...input.session, header: { ...input.session.header, cwd: foreignCwd } } })
    expect(parseSessionArchive(sealed).session.header.cwd).toBe(foreignCwd)
  })
  it('不接受错误摘要、路径穿越、跨剧情文件及大小写别名', () => {
    for (const mutate of [
      (x: ReturnType<typeof fixture>) => { x.files[2]!.data = Buffer.from('不符摘要').toString('base64') },
      (x: ReturnType<typeof fixture>) => { x.files[2]!.path = '../other' },
      (x: ReturnType<typeof fixture>) => { x.files[0]!.path = 'stories/other/story.json' },
      (x: ReturnType<typeof fixture>) => { x.files.push({ ...x.files[2]!, path: 'MEMORY/FACT.md' }) },
    ]) { const input = fixture(); mutate(input); expect(() => parseSessionArchive(input)).toThrow() }
  })
  it('宿主事件不连续或剧情属于其它会话时拒绝', () => {
    const mismatch = fixture(); mismatch.binding.sessionId = 'another-session'
    expect(() => parseSessionArchive(mismatch)).toThrow()
    const wrongStory = fixture()
    wrongStory.files[1] = archiveFile('story', 'story.json', Buffer.from(JSON.stringify({ version: 1, id: wrongStory.binding.storyId, sessionId: 'other', createdAt: '2026-01-01', migrated: false })))
    expect(() => parseSessionArchive(wrongStory)).toThrow()
    const invalidCut = fixture(); invalidCut.session.inheritedEventCount = 1
    expect(() => parseSessionArchive(invalidCut)).toThrow()
  })
  it('整份清单摘要能发现整条文件记录或元数据被删除', () => {
    const missing = fixture(); missing.files.splice(2, 1)
    expect(() => parseSessionArchive(missing)).toThrow()
    const changed = fixture(); changed.binding.cardName = '另一个角色'
    expect(() => parseSessionArchive(changed)).toThrow()
  })
})
