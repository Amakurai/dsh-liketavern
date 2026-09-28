import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 唤醒本轮的非用户输入排版（conversation.chat.node / turn-trigger）。
 *
 * 宿主 0.1.7 把唤醒一轮的非 user 来源消息画成可展开的「收到执行请求」行，展开即显示原文；
 * Tavern 的续写靠一条合成指令唤醒，原样展示会把内部提示词暴露在剧情里。宿主没有隐藏或
 * 渲染被遮挡原生行的公开接口，因此 Tavern 视图显示期间接管该覆盖位：插件自身的指令只
 * 显示一行简短说明；其它来源保留通用说明与可展开原文，不丢信息。
 */
import { CONTINUE_INSTRUCTION_PREFIX } from '../core/dshPrompt.js';
import { useT } from './i18n.js';
export function TavernTurnTrigger(props) {
    const t = useT();
    const text = (props.node.data.content ?? []).map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('\n');
    if (props.node.data.source?.kind === 'dsh-tavern') {
        return (_jsx("div", { className: "dsh-tavern-trigger", "data-tavern-trigger": "plugin", children: text.startsWith(CONTINUE_INSTRUCTION_PREFIX) ? t('trigger.continue') : t('trigger.tavern') }));
    }
    return (_jsxs("details", { className: "dsh-tavern-reason dsh-tavern-trigger", "data-tavern-trigger": "external", children: [_jsx("summary", { children: t('trigger.external') }), _jsx("pre", { children: text })] }));
}
