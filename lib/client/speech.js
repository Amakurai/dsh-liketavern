import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 角色发言条：头像 + 名字 + 正文。正文经 output/render 正则后，
 * 再收起 UpdateVariable 等机读标签；整页 HTML 进沙箱 iframe，其余走 Markdown。
 *
 * 封面 iframe：允许 https 图片/字体；注入 ST getChatMessages/setChatMessage stub，
 * 卡内按钮经 postMessage 请求宿主 swipeGreeting。无 allow-same-origin。
 * 正则若只把标记换成 HTML，iframe 下面仍渲染剩余正文。
 */
import { useEffect, useRef, useState } from 'react';
import { IconCopyOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { buildCardSrcDoc, parseCardBridgeMessage } from '../core/cardFrame.js';
import { stripDisplayMeta } from '../core/displaySanitize.js';
import { cachedAvatar } from './cache.js';
import { useT, useMarkdownLabels } from './i18n.js';
import { Avatar, IconBtn, useLoader, useToast } from './util.js';
import './styles.js';
function SpeechHtmlFrame(props) {
    const iframeRef = useRef(null);
    const [frameH, setFrameH] = useState(null);
    useEffect(() => {
        setFrameH(null);
    }, [props.srcDoc]);
    useEffect(() => {
        const onMsg = (e) => {
            if (iframeRef.current && e.source !== iframeRef.current.contentWindow)
                return;
            const parsed = parseCardBridgeMessage(e.data);
            if (!parsed)
                return;
            if (parsed.action === 'swipeGreeting' && typeof parsed.index === 'number') {
                props.onSwipeGreeting?.(parsed.index);
            }
            if (parsed.action === 'resize' && typeof parsed.height === 'number' && Number.isFinite(parsed.height)) {
                setFrameH(Math.min(8000, Math.max(80, Math.ceil(parsed.height))));
            }
        };
        window.addEventListener('message', onMsg);
        return () => window.removeEventListener('message', onMsg);
    }, [props.onSwipeGreeting]);
    const frameStyle = frameH != null
        ? { height: frameH, minHeight: 0, overflow: 'hidden' }
        : props.widget
            ? { height: 280, minHeight: 0, overflow: 'auto' }
            : { overflow: 'auto' };
    return (_jsx("iframe", { ref: iframeRef, className: `dsh-tavern-speechHtml${props.widget ? ' is-widget' : ''}`, sandbox: "allow-scripts", srcDoc: props.srcDoc, title: props.title, style: frameStyle }));
}
export function SpeechBubble(props) {
    const { remote, sessionId, cardId, name, rawText, streaming, onSwipeGreeting } = props;
    const t = useT();
    const markdownLabels = useMarkdownLabels();
    // 头像走进程内缓存（key=cardId，TTL 60s）：同一会话的 N 条气泡不再各传一次 dataURL。
    const avatar = useLoader(() => cachedAvatar(remote, cardId), [cardId], Boolean(cardId));
    const rendered = useLoader(() => remote.renderOutputText({ sessionId, text: rawText }), [sessionId, rawText], Boolean(rawText) && !streaming);
    const avatarUrl = avatar.state.status === 'ready' ? avatar.state.value.dataUrl : null;
    // 交互卡渲染决策：会话绑定有值时优先于全局设置（renderOutputText 回包的
    // interactiveCards 即全局值）。HTML 抽取在服务端按全局开关做，会话关 → 不渲染
    // 封面 iframe；正文若已随抽取变空，回退原始文本，对齐全局关闭的「纯文本显示」。
    const interactive = props.interactiveCards ?? (rendered.state.status === 'ready' ? rendered.state.value.interactiveCards : true);
    const htmls = !streaming && interactive && rendered.state.status === 'ready'
        ? rendered.state.value.htmls && rendered.state.value.htmls.length > 0
            ? rendered.state.value.htmls
            : rendered.state.value.html
                ? [rendered.state.value.html]
                : []
        : [];
    const text = !streaming && rendered.state.status === 'ready'
        ? interactive || rendered.state.value.text
            ? rendered.state.value.text
            : stripDisplayMeta(rawText)
        : stripDisplayMeta(rawText);
    const whitelist = rendered.state.status === 'ready' ? rendered.state.value.whitelist : [];
    const greetings = rendered.state.status === 'ready' ? rendered.state.value.greetings ?? [] : [];
    const greetingIndex = rendered.state.status === 'ready' ? rendered.state.value.greetingIndex ?? 0 : 0;
    const canSwipe = rendered.state.status === 'ready' ? rendered.state.value.canSwipeGreeting !== false : false;
    const toast = useToast();
    /** 复制纯文本：优先 navigator.clipboard，沙盒/权限被拒时回退 execCommand。 */
    const onCopy = async () => {
        const plain = text || stripDisplayMeta(rawText);
        const fallback = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = plain;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                toast.show(ok ? t('speech.copied') : t('speech.copyFailed'));
            }
            catch {
                toast.show(t('speech.copyFailed'));
            }
        };
        try {
            await navigator.clipboard.writeText(plain);
            toast.show(t('speech.copied'));
        }
        catch {
            fallback();
        }
    };
    const frames = htmls.map((html, i) => {
        const srcDoc = buildCardSrcDoc(html, { greetings, greetingIndex, connectHosts: whitelist });
        const widget = htmls.length > 1 ? i > 0 : Boolean(text);
        return (_jsx(SpeechHtmlFrame, { srcDoc: srcDoc, title: name, widget: widget, onSwipeGreeting: canSwipe ? onSwipeGreeting : undefined }, `${i}:${html.length}`));
    });
    return (_jsxs("div", { className: "dsh-tavern-speech dsh-tavern-rise", children: [_jsx(Avatar, { url: avatarUrl, name: name, size: 40, className: "dsh-tavern-speechAvatar" }), _jsxs("div", { className: "dsh-tavern-speechBody", children: [_jsx("div", { className: "dsh-tavern-speechName", children: name }), frames, (frames.length === 0 || text) && (_jsx(MarkdownText, { text: text || ' ', streaming: Boolean(streaming), labels: markdownLabels }))] }), _jsx("div", { className: "dsh-tavern-speechCopy", children: _jsx(IconBtn, { label: t('speech.copy'), onClick: () => void onCopy(), children: _jsx(IconCopyOutline16, {}) }) }), toast.node] }));
}
