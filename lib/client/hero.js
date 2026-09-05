import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 新会话英雄区的角色卡选择（slot conversation.input.dock）。
 *
 * 平台英雄行只有 workspace / agentPreset 两个座位，角色芯片经 portal 并入该行。
 * 选中角色卡后先预览开场白，点「开始对话」再写入日志；封面 HTML 在聊天区渲染。
 * 开场白 swipe 也可在进入对话之后的 assistant 工具栏右侧使用。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronLeftOutline14, IconChevronRightOutline14, } from '@deepseek-ai/dsh-client-ui-primitives';
import { CharacterPicker, rememberCharacter } from './characterPicker.js';
import { BINDING_CHANGED_EVENT } from './actions.js';
import { cachedAvatar, cachedCharacterDetail, invalidateSessionBinding } from './cache.js';
import { bindingFromDefaults } from './chip.js';
import { useT } from './i18n.js';
import { isTavernSession } from './mode.js';
import { TavernSeatChip } from './seatChip.js';
import { Avatar, Btn, errOf, Skeleton, useLoader } from './util.js';
import { expandIdentityMacros } from '../core/macros.js';
import { DEFAULT_USER_NAME } from '../core/persona.js';
import './styles.js';
/** 芯片只能并入英雄行，绝不能塞进模式选择按钮内部（会把菜单点坏）。 */
function isSafeChipHost(el, from) {
    return el.tagName !== 'BUTTON' && el.closest('button') === null && el !== from && !from.contains(el);
}
/** 从 dock 节点向上找英雄芯片行（workspace + 模式选择所在的 flex 行）。 */
function findHeroChipRow(from) {
    const seat = from?.closest('[data-composer-seat]');
    if (!(seat instanceof HTMLElement) || !from)
        return null;
    let node = from;
    while (node && node !== seat) {
        const prev = node.previousElementSibling;
        if (prev instanceof HTMLElement && isSafeChipHost(prev, from) && prev.querySelector('button[aria-haspopup="menu"]')) {
            return prev;
        }
        node = node.parentElement;
    }
    const buttons = Array.from(seat.querySelectorAll('button[aria-haspopup="menu"]')).filter((b) => !b.closest('[data-tavern-hero-seat]'));
    for (const btn of buttons) {
        let parent = btn.parentElement;
        while (parent && parent !== seat) {
            if (isSafeChipHost(parent, from) &&
                getComputedStyle(parent).display === 'flex' &&
                parent.querySelectorAll('button[aria-haspopup="menu"]').length >= 2) {
                return parent;
            }
            parent = parent.parentElement;
        }
    }
    return null;
}
function greetingVariants(detail) {
    return [detail.firstMes, ...detail.alternateGreetings];
}
/** 会话切换时卸载旧选择器，异步结果不能把忙碌态、错误或弹窗带到新会话。 */
export function TavernHeroCharacter(props) {
    return _jsx(HeroCharacterSession, { ...props }, props.sessionId);
}
function HeroCharacterSession(props) {
    const { remote, sessionId, session } = props;
    const t = useT();
    const tavern = isTavernSession(props.useSessions, sessionId);
    const eligible = tavern && session?.blank === true && session.promptAttempted !== true;
    const [entered, setEntered] = useState(false);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; };
    }, []);
    const dockRef = useRef(null);
    const [chipHost, setChipHost] = useState(null);
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // 空白判定涉及写操作，不使用可能仍缓存着「未开始」的绑定快照。
    const bindingLoader = useLoader(() => remote.getSessionBinding({ sessionId }), [sessionId], eligible);
    const started = bindingLoader.state.status === 'ready' && bindingLoader.state.value.conversationStarted;
    const showHero = eligible && !entered && !started;
    useEffect(() => {
        if (eligible && started)
            void props.sessions.refresh?.().catch(() => { });
    }, [eligible, started, props.sessions]);
    const binding = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.binding : null;
    const userName = bindingLoader.state.status === 'ready' ? (bindingLoader.state.value.userName || DEFAULT_USER_NAME) : DEFAULT_USER_NAME;
    const charsLoader = useLoader(() => remote.listCharacters({}), [sessionId], showHero);
    const characters = charsLoader.state.status === 'ready' ? charsLoader.state.value.items : [];
    const detailLoader = useLoader(() => cachedCharacterDetail(remote, binding.cardId), [binding?.cardId], showHero && binding !== null);
    const avatarLoader = useLoader(() => cachedAvatar(remote, binding.cardId), [binding?.cardId], showHero && binding !== null);
    useEffect(() => {
        if (!showHero)
            return;
        const onChanged = (e) => {
            if (e.detail === sessionId)
                bindingLoader.reload();
        };
        window.addEventListener(BINDING_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(BINDING_CHANGED_EVENT, onChanged);
        // reload 随 loader 每次 render 换新引用，只跟会话走。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showHero, sessionId]);
    /** 用户正在点选角色：不要把刚写入的绑定当成「上次留下的」清掉。 */
    const picking = useRef(false);
    const clearing = useRef(false);
    /** 每个空白会话只清一次陈旧绑定；之后用户点选的角色要留着预览。 */
    const sweptSession = useRef(null);
    useEffect(() => {
        sweptSession.current = null;
        picking.current = false;
    }, [sessionId]);
    // 新对话常会复用仍空白的 Tavern 会话；清掉上次留下的角色绑定，才能切回其他模式。
    useEffect(() => {
        if (!showHero) {
            picking.current = false;
            return;
        }
        if (picking.current || busy || clearing.current)
            return;
        if (bindingLoader.state.status !== 'ready')
            return;
        if (sweptSession.current === sessionId)
            return;
        sweptSession.current = sessionId;
        if (!binding)
            return;
        clearing.current = true;
        void (async () => {
            try {
                if (picking.current)
                    return;
                const r = await remote.clearSessionBinding({ sessionId, onlyIfBlank: true });
                if (picking.current)
                    return;
                const err = errOf(r);
                if (err) {
                    setError(err);
                    return;
                }
                if (r.ok && !r.value.cleared)
                    setEntered(true);
                invalidateSessionBinding(sessionId);
                window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
                bindingLoader.reload();
            }
            catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
            }
            finally {
                clearing.current = false;
            }
        })();
        // reload 随 loader 每次 render 换新引用；只跟空白会话上的陈旧绑定走。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showHero, bindingLoader.state.status, binding?.cardId, sessionId]);
    useLayoutEffect(() => {
        if (!showHero) {
            setChipHost(null);
            return;
        }
        const apply = () => {
            const host = findHeroChipRow(dockRef.current);
            setChipHost((prev) => (prev === host ? prev : host));
            return host;
        };
        if (apply())
            return;
        const seat = dockRef.current?.closest('[data-composer-seat]');
        const root = seat instanceof HTMLElement ? seat : document.body;
        const obs = new MutationObserver(() => {
            if (apply())
                obs.disconnect();
        });
        obs.observe(root, { childList: true, subtree: true });
        const timer = window.setTimeout(() => {
            apply();
            obs.disconnect();
        }, 2000);
        return () => {
            obs.disconnect();
            window.clearTimeout(timer);
        };
    }, [showHero, sessionId, binding?.cardId]);
    if (!showHero)
        return null;
    const detail = detailLoader.state.status === 'ready' ? detailLoader.state.value : null;
    const avatar = avatarLoader.state.status === 'ready' ? avatarLoader.state.value.dataUrl : null;
    const selected = binding ? characters.find((c) => c.cardId === binding.cardId) : undefined;
    const chipLabel = binding ? (detail?.name ?? selected?.name ?? t('hero.characterFallback')) : t('hero.pickCharacter');
    const variants = detail ? greetingVariants(detail) : [];
    const greetingIndex = binding?.greetingIndex ?? 0;
    const greetingText = detail
        ? expandIdentityMacros(variants[greetingIndex] ?? variants[0] ?? '', { char: detail?.name ?? chipLabel, user: userName })
        : '';
    const hasAnyGreeting = variants.some((v) => v.trim() !== '');
    // 头像旁的元信息行：作者 / 版本 / 前三个标签，有才显示。
    const metaParts = [];
    if (detail?.creator)
        metaParts.push(t('hero.creator', { name: detail.creator }));
    if (detail?.characterVersion)
        metaParts.push(`v${detail.characterVersion}`);
    if (detail && detail.tags.length > 0)
        metaParts.push(detail.tags.slice(0, 3).join(' · '));
    const pickCharacter = async (cardId) => {
        if (!cardId || busy)
            return;
        picking.current = true;
        sweptSession.current = sessionId;
        setBusy(true);
        setError(null);
        try {
            while (clearing.current)
                await new Promise((resolve) => setTimeout(resolve, 20));
            if (!alive.current)
                return;
            // 点选角色始终重新读取默认配置；不能复用清扫请求发出前 render 闭包里的陈旧 binding。
            const next = await bindingFromDefaults(remote, sessionId, cardId);
            if (!alive.current)
                return;
            const saved = await remote.setSessionBinding({ binding: next });
            const saveErr = errOf(saved);
            if (saveErr) {
                setError(saveErr);
                return;
            }
            invalidateSessionBinding(sessionId);
            window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
            bindingLoader.reload();
            rememberCharacter(remote, cardId);
            setOpen(false);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setBusy(false);
        }
    };
    const startConversation = async () => {
        if (!binding || busy)
            return;
        picking.current = true;
        setBusy(true);
        setError(null);
        try {
            if (!greetingText.trim() && hasAnyGreeting) {
                setError(t('hero.error.emptyGreetingVariant'));
                return;
            }
            if (!greetingText.trim()) {
                setError(t('hero.error.noGreetingInput'));
                return;
            }
            const entered = await remote.ensureGreeting({ sessionId });
            const enterErr = errOf(entered);
            if (enterErr)
                setError(enterErr);
            else if (entered.ok) {
                if (entered.value.created || entered.value.conversationStarted) {
                    invalidateSessionBinding(sessionId);
                    window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
                    setEntered(true);
                    // 插件直接追加日志不会经过宿主 send；主动同步 blank，解除空白会话复用。
                    try {
                        await props.sessions.refresh?.();
                    }
                    catch (cause) {
                        setEntered(false);
                        throw cause;
                    }
                }
                else
                    setError(t('hero.error.enterFailed'));
            }
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setBusy(false);
        }
    };
    /** 空白页只改绑定下标，不 fork、不写日志，以免毁掉可复用的空白会话。 */
    const swipeTo = async (index) => {
        if (!binding || busy)
            return;
        setBusy(true);
        setError(null);
        try {
            const saved = await remote.setSessionBinding({ binding: { ...binding, greetingIndex: index } });
            const saveErr = errOf(saved);
            if (saveErr)
                setError(saveErr);
            else {
                invalidateSessionBinding(sessionId);
                window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
                bindingLoader.reload();
            }
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setBusy(false);
        }
    };
    const swipe = async (delta) => {
        if (!binding || variants.length < 2)
            return;
        const next = ((greetingIndex + delta) % variants.length + variants.length) % variants.length;
        await swipeTo(next);
    };
    const chip = (_jsx("span", { "data-tavern-hero-seat": "", className: "dsh-tavern-ui", children: _jsx(TavernSeatChip, { label: chipLabel, title: t('hero.pickCharacter'), avatarUrl: avatar, open: open, hasPopup: "dialog", loading: bindingLoader.state.status === 'loading', disabled: busy, onClick: () => { setError(null); setOpen(true); } }) }));
    return (_jsxs("div", { ref: dockRef, "data-tavern-hero-root": "", className: "dsh-tavern-ui", children: [chipHost ? createPortal(chip, chipHost) : chip, open && _jsx(CharacterPicker, { remote: remote, selectedId: binding?.cardId, busy: busy, error: error, onPick: (id) => void pickCharacter(id), onClose: () => setOpen(false) }), error && _jsx("div", { className: "dsh-tavern-hero-error", children: error }), bindingLoader.state.status === 'error' && _jsxs("div", { role: "alert", className: "dsh-tavern-hero-error", children: [bindingLoader.state.message, _jsx(Btn, { onClick: bindingLoader.reload, disabled: busy, children: t('action.retry') })] }), binding && detailLoader.state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-hero-preview", "aria-busy": "true", children: [_jsxs("div", { className: "dsh-tavern-hero-previewHead", children: [_jsx(Skeleton, { width: 28, height: 28, radius: 999 }), _jsx(Skeleton, { width: 140, height: 14 })] }), _jsx(Skeleton, { height: 14, style: { marginTop: 14 } }), _jsx(Skeleton, { height: 14, width: "72%", style: { marginTop: 8 } }), _jsx(Skeleton, { height: 14, width: "48%", style: { marginTop: 8 } }), _jsx(Skeleton, { height: 32, width: 104, radius: 18, style: { marginTop: 14 } })] })), binding && detailLoader.state.status !== 'loading' && (_jsxs("div", { className: "dsh-tavern-hero-preview dsh-tavern-rise", tabIndex: variants.length > 1 ? 0 : undefined, onKeyDown: (e) => {
                    // ←/→ 切换开场白变体；只在卡片本身聚焦时响应，避免抢子按钮的键盘事件
                    if (variants.length < 2 || e.target !== e.currentTarget)
                        return;
                    if (e.key === 'ArrowLeft') {
                        e.preventDefault();
                        void swipe(-1);
                    }
                    else if (e.key === 'ArrowRight') {
                        e.preventDefault();
                        void swipe(1);
                    }
                }, children: [_jsxs("div", { className: "dsh-tavern-hero-previewHead", children: [_jsx(Avatar, { url: avatar, name: chipLabel, size: 40, className: "dsh-tavern-speechAvatar" }), _jsxs("div", { className: "dsh-tavern-hero-previewHeadText", children: [_jsx("div", { className: "dsh-tavern-hero-previewName", children: chipLabel }), metaParts.length > 0 && _jsx("div", { className: "dsh-tavern-hero-previewMeta", children: metaParts.join(' · ') })] })] }), detailLoader.state.status === 'error' ? (_jsx("div", { className: "dsh-tavern-hero-previewText", children: t('hero.detailLoadFailed') })) : greetingText ? (_jsx("div", { className: "dsh-tavern-hero-quote", children: greetingText })) : hasAnyGreeting ? (_jsx("div", { className: "dsh-tavern-hero-previewText", children: t('hero.emptyVariantHint') })) : (_jsx("div", { className: "dsh-tavern-hero-previewText", children: t('hero.noGreetingHint') })), _jsxs("div", { className: "dsh-tavern-hero-actions", children: [_jsx(Btn, { primary: true, size: "md", disabled: busy || !greetingText.trim() || !detail, onClick: () => void startConversation(), children: t('hero.start') }), variants.length > 1 && (_jsxs("div", { className: "dsh-tavern-hero-swipe", children: [_jsx("button", { type: "button", className: "dsh-tavern-hero-swipeBtn", disabled: busy, title: t('hero.prevGreeting'), onClick: () => void swipe(-1), children: _jsx(IconChevronLeftOutline14, {}) }), _jsxs("span", { className: "dsh-tavern-hero-swipeIdx", children: [greetingIndex + 1, "/", variants.length] }), _jsx("button", { type: "button", className: "dsh-tavern-hero-swipeBtn", disabled: busy, title: t('hero.nextGreeting'), onClick: () => void swipe(1), children: _jsx(IconChevronRightOutline14, {}) }), _jsx("span", { className: "dsh-tavern-hero-swipeHint", children: t('hero.swipeHint') })] }))] })] }))] }));
}
