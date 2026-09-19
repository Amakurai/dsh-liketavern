import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/** 关于页展示本机插件信息；仅在点击时检查正式发布，提供宿主 CLI 更新步骤，不执行安装。 */
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n.js';
import { Badge, Btn, Err, Muted, Section, SettingsRow, Skeleton, useLoader, useToast } from '../util.js';
const PROJECT_URL = 'https://github.com/Amakurai/dsh-liketavern';
const STATUS_KEYS = {
    current: 'about.current', available: 'about.available', ahead: 'about.ahead', incompatible: 'about.incompatible',
};
/** 新网页可能连着仍未重启的旧宿主；只识别本接口明确缺失，不能把断网或磁盘错误当成版本问题。 */
function needsHostRestart(error) {
    return ['gateway/method-unavailable', 'gateway/definition-unavailable', 'gateway/invocation-unavailable'].includes(error.code)
        || (error.code === 'gateway/internal' && error.message === 'client api: tavern/getPluginAbout failed: transport failure for /api/tavern/getPluginAbout: HTTP 404');
}
export function AboutSection({ remote }) {
    const t = useT();
    const toast = useToast();
    const { state, reload } = useLoader(async () => {
        const response = await remote.getPluginAbout({});
        if (response.ok)
            return response;
        return { ...response, error: { ...response.error, message: needsHostRestart(response.error) ? 'about.restartRequired' : 'about.loadFailed' } };
    }, [remote]);
    const owner = useMemo(() => ({ alive: true, busy: false }), [remote]);
    const [check, setCheck] = useState();
    useEffect(() => { owner.alive = true; return () => { owner.alive = false; }; }, [owner]);
    const visible = check?.owner === owner ? check : undefined;
    const info = state.status === 'ready' ? state.value : undefined;
    const result = visible?.result;
    const version = (value) => value === 'unknown' ? t('about.unknown') : value;
    const checkUpdate = async () => {
        if (owner.busy || !info || info.hostVersion === 'unknown')
            return;
        owner.busy = true;
        setCheck({ owner, busy: true });
        let timer;
        try {
            const response = await Promise.race([
                remote.checkPluginUpdate({}),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 20_000); }),
            ]);
            if (!response.ok)
                throw new Error(response.error.message);
            if (owner.alive)
                setCheck({ owner, busy: false, result: response.value });
        }
        catch {
            if (owner.alive)
                setCheck({ owner, busy: false, failed: true });
        }
        finally {
            clearTimeout(timer);
            owner.busy = false;
        }
    };
    const copyCommand = async (command) => {
        try {
            await navigator.clipboard.writeText(command);
            if (owner.alive)
                toast.show(t('about.copied'));
        }
        catch {
            if (owner.alive)
                toast.show(t('about.copyFailed'));
        }
    };
    return _jsxs(_Fragment, { children: [toast.node, _jsx(Section, { title: t('about.title'), description: t('about.description'), children: _jsxs("div", { className: "dsh-tavern-aboutProject", children: [_jsxs("div", { className: "dsh-tavern-aboutName", children: ["dsh-liketavern ", info && _jsxs(Badge, { accent: true, children: ["v", info.version] })] }), _jsx(SettingsRow, { title: t('about.project'), children: _jsx("a", { className: "dsh-tavern-aboutLink", href: info?.repositoryUrl ?? PROJECT_URL, target: "_blank", rel: "noopener noreferrer", children: "github.com/Amakurai/dsh-liketavern" }) }), state.status === 'loading' && _jsx(Skeleton, { height: 74 }), state.status === 'error' && _jsxs(_Fragment, { children: [_jsx(Err, { message: t(state.message === 'about.restartRequired' ? 'about.restartRequired' : 'about.loadFailed') }), _jsx(Btn, { onClick: reload, children: t('action.retry') })] }), info && _jsxs(_Fragment, { children: [_jsx(SettingsRow, { title: t('about.version'), children: _jsx("span", { children: version(info.version) }) }), _jsx(SettingsRow, { title: t('about.host'), description: t('about.hostRequired', { version: version(info.expectedHostVersion) }), children: _jsx("span", { children: version(info.hostVersion) }) }), info.hostVersion === 'unknown' && _jsx(Muted, { children: t('about.hostUnknown') }), info.sourceCheckout && _jsxs("div", { className: "dsh-tavern-aboutSource", children: [_jsx(Badge, { children: t('about.source') }), _jsx(Muted, { children: t('about.sourceHint') })] })] })] }) }), _jsxs(Section, { title: t('about.updates'), description: t('about.updateHint'), children: [_jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(Btn, { primary: true, disabled: !info || info.hostVersion === 'unknown' || visible?.busy, onClick: () => void checkUpdate(), children: t(visible?.busy ? 'about.checking' : 'about.check') }), _jsx("a", { className: "dsh-tavern-aboutLink", href: result?.releaseUrl ?? info?.releasesUrl ?? `${PROJECT_URL}/releases`, target: "_blank", rel: "noopener noreferrer", children: t('about.releases') })] }), _jsx(Muted, { children: t('about.cliNote') }), _jsx("div", { role: "status", "aria-live": "polite", children: result && _jsx("p", { className: "dsh-tavern-aboutStatus", children: t(STATUS_KEYS[result.status], { version: result.latestVersion, host: result.requiredHostVersion }) }) }), _jsx(Err, { message: visible?.failed ? t('about.checkFailed') : null }), result?.status === 'available' && result.command && !info?.sourceCheckout && _jsxs("div", { className: "dsh-tavern-aboutInstructions", children: [_jsx("h4", { children: t('about.steps') }), _jsx("p", { children: t('about.instructions') }), _jsx("pre", { className: "dsh-tavern-aboutCommand", children: _jsx("code", { children: result.command }) }), _jsx(Btn, { onClick: () => void copyCommand(result.command), children: t('about.copyCommand') }), _jsx(Muted, { children: t('about.profileNote') })] })] })] });
}
