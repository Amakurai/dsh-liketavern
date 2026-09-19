/** 关于页展示本机插件信息；仅在点击时检查正式发布，提供宿主 CLI 更新步骤，不执行安装。 */
import { useEffect, useMemo, useState } from 'react'
import type { TavernMethodResults } from '../../remote.js'
import type { TavernRemote } from '../types.js'
import { useT } from '../i18n.js'
import { Badge, Btn, Err, Muted, Section, SettingsRow, Skeleton, useLoader, useToast } from '../util.js'

const PROJECT_URL = 'https://github.com/Amakurai/dsh-liketavern'
type Update = TavernMethodResults['checkPluginUpdate']
const STATUS_KEYS = {
  current: 'about.current', available: 'about.available', ahead: 'about.ahead', incompatible: 'about.incompatible',
} as const

/** 新网页可能连着仍未重启的旧宿主；只识别本接口明确缺失，不能把断网或磁盘错误当成版本问题。 */
function needsHostRestart(error: { code: string; message: string }): boolean {
  return ['gateway/method-unavailable', 'gateway/definition-unavailable', 'gateway/invocation-unavailable'].includes(error.code)
    || (error.code === 'gateway/internal' && error.message === 'client api: tavern/getPluginAbout failed: transport failure for /api/tavern/getPluginAbout: HTTP 404')
}

export function AboutSection({ remote }: { remote: TavernRemote }) {
  const t = useT()
  const toast = useToast()
  const { state, reload } = useLoader(async () => {
    const response = await remote.getPluginAbout({})
    if (response.ok) return response
    return { ...response, error: { ...response.error, message: needsHostRestart(response.error) ? 'about.restartRequired' : 'about.loadFailed' } }
  }, [remote])
  const owner = useMemo(() => ({ alive: true, busy: false }), [remote])
  const [check, setCheck] = useState<{ owner: typeof owner; busy: boolean; result?: Update; failed?: boolean }>()
  useEffect(() => { owner.alive = true; return () => { owner.alive = false } }, [owner])
  const visible = check?.owner === owner ? check : undefined
  const info = state.status === 'ready' ? state.value : undefined
  const result = visible?.result
  const version = (value: string) => value === 'unknown' ? t('about.unknown') : value

  const checkUpdate = async () => {
    if (owner.busy || !info || info.hostVersion === 'unknown') return
    owner.busy = true
    setCheck({ owner, busy: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        remote.checkPluginUpdate({}),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 20_000) }),
      ])
      if (!response.ok) throw new Error(response.error.message)
      if (owner.alive) setCheck({ owner, busy: false, result: response.value })
    } catch {
      if (owner.alive) setCheck({ owner, busy: false, failed: true })
    } finally {
      clearTimeout(timer)
      owner.busy = false
    }
  }

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      if (owner.alive) toast.show(t('about.copied'))
    } catch {
      if (owner.alive) toast.show(t('about.copyFailed'))
    }
  }

  return <>
    {toast.node}
    <Section title={t('about.title')} description={t('about.description')}>
      <div className="dsh-tavern-aboutProject">
        <div className="dsh-tavern-aboutName">dsh-liketavern {info && <Badge accent>v{info.version}</Badge>}</div>
        <SettingsRow title={t('about.project')}>
          <a className="dsh-tavern-aboutLink" href={info?.repositoryUrl ?? PROJECT_URL} target="_blank" rel="noopener noreferrer">github.com/Amakurai/dsh-liketavern</a>
        </SettingsRow>
        {state.status === 'loading' && <Skeleton height={74} />}
        {state.status === 'error' && <><Err message={t(state.message === 'about.restartRequired' ? 'about.restartRequired' : 'about.loadFailed')} /><Btn onClick={reload}>{t('action.retry')}</Btn></>}
        {info && <>
          <SettingsRow title={t('about.version')}><span>{version(info.version)}</span></SettingsRow>
          <SettingsRow title={t('about.host')} description={t('about.hostRequired', { version: version(info.expectedHostVersion) })}>
            <span>{version(info.hostVersion)}</span>
          </SettingsRow>
          {info.hostVersion === 'unknown' && <Muted>{t('about.hostUnknown')}</Muted>}
          {info.sourceCheckout && <div className="dsh-tavern-aboutSource"><Badge>{t('about.source')}</Badge><Muted>{t('about.sourceHint')}</Muted></div>}
        </>}
      </div>
    </Section>
    <Section title={t('about.updates')} description={t('about.updateHint')}>
      <div className="dsh-tavern-toolbar">
        <Btn primary disabled={!info || info.hostVersion === 'unknown' || visible?.busy} onClick={() => void checkUpdate()}>{t(visible?.busy ? 'about.checking' : 'about.check')}</Btn>
        <a className="dsh-tavern-aboutLink" href={result?.releaseUrl ?? info?.releasesUrl ?? `${PROJECT_URL}/releases`} target="_blank" rel="noopener noreferrer">{t('about.releases')}</a>
      </div>
      <Muted>{t('about.cliNote')}</Muted>
      <div role="status" aria-live="polite">
        {result && <p className="dsh-tavern-aboutStatus">{t(STATUS_KEYS[result.status], { version: result.latestVersion, host: result.requiredHostVersion })}</p>}
      </div>
      <Err message={visible?.failed ? t('about.checkFailed') : null} />
      {result?.status === 'available' && result.command && !info?.sourceCheckout && <div className="dsh-tavern-aboutInstructions">
        <h4>{t('about.steps')}</h4>
        <p>{t('about.instructions')}</p>
        <pre className="dsh-tavern-aboutCommand"><code>{result.command}</code></pre>
        <Btn onClick={() => void copyCommand(result.command!)}>{t('about.copyCommand')}</Btn>
        <Muted>{t('about.profileNote')}</Muted>
      </div>}
    </Section>
  </>
}
