/**
 * dsh-tavern 浏览器端入口。
 * 注册五块 UI：设置面板、assistant 操作条、会话头部角色 chip、
 * 新会话英雄区角色选择、对话区 assistant 消息排版；并注册 tavern 文案命名空间。
 *
 * conversation.chat.node / assistant-step 是 keyed 覆盖位：登记就会挡住原生
 * AssistantNodeView。因此只在当前会话是 Tavern 模式时才挂上，切走即卸掉。
 */
import { TYPERT_REMOTE } from '../remote.js';
import { TavernFloorActions } from './actions.js';
import { TavernAssistantNode } from './assistant.js';
import { TavernHeaderChip } from './chip.js';
import { TavernHeroCharacter } from './hero.js';
import { setTavernHostLocale, setTavernLocale } from './i18n.js';
import { en, zh } from './locales.js';
import { isCurrentTavernSession } from './mode.js';
import { TavernPanel } from './panel/index.js';
import { installTavernSeatWatch } from './seatWatch.js';
export const name = 'dsh-tavern-client';
// 注意：不能声明 'remote.tavern' —— 该服务由下方 $mount 在 apply 内自行安装，
// 注入声明会让加载器在 apply 前等待一个尚不存在的服务（死锁）。安装后经
// ctx.get('remote.tavern') 读取（reflect.get 不做 inject 检查），
// 也不要写 ctx.remote.tavern（追踪代理会按点路径检查 inject）。
export const inject = ['slots', 'remote', 'locale', 'sessions', 'workspaces'];
export async function apply(ctx) {
    await ctx.remote.$mount(TYPERT_REMOTE);
    const remote = ctx.get('remote.tavern');
    const sessions = ctx.sessions;
    // 界面语言在挂载 slot 前播种（持久化于 dsh-tavern 设置的 locale 键），避免先英文闪一下再切走。
    try {
        const result = await remote.getSettings({});
        if (result.ok)
            setTavernLocale(result.value.settings.locale);
    }
    catch {
        // 读取失败保持默认（auto 跟随宿主）。
    }
    // auto 档跟随宿主界面语言（0.1.2 的 LocaleRuntime 快照 + 订阅）。
    ctx.effect(() => {
        const sync = () => setTavernHostLocale(ctx.locale.getSnapshot?.().active ?? 'en');
        sync();
        return ctx.locale.subscribe?.(sync) ?? (() => { });
    }, 'dsh-tavern: host locale');
    ctx.effect(() => ctx.locale.register('tavern', { zh, en }), 'dsh-tavern: locale');
    // 无会话 hero 上选「Tavern 模式」时自动补一次「新对话」，让暂存的模式选择落地。
    ctx.effect(() => installTavernSeatWatch(ctx), 'dsh-tavern: seat watch');
    /** slot 声明可能尚未就位（插件加载顺序），优先经 slots.inject 延迟注册。 */
    const mount = (slotName, options, component) => {
        if (typeof ctx.slots.inject === 'function') {
            ctx.slots.inject(slotName, () => ctx.slots.register({ ...options, name: slotName }, component));
        }
        else {
            ctx.effect(() => ctx.slots.register({ ...options, name: slotName }, component), `dsh-tavern: slot ${slotName}`);
        }
    };
    // A. 设置面板（root 作用域；导入卡/预设不依赖当前会话模式）
    mount('settings.section', { id: 'tavern', order: 50, label: 'Tavern', inject: () => ({ remote }) }, TavernPanel);
    // B. assistant 消息操作条（session 作用域；组件内再按 Tavern 模式显隐）
    mount('conversation.chat.assistant-actions', { id: 'tavern-floors', order: 20, inject: (sessionId) => ({ remote, sessionId, sessions }) }, TavernFloorActions);
    // C. 会话头部角色 chip（session 作用域；对话开始后可见）
    mount('conversation.session.header.actions', { id: 'tavern-binding', order: 20, inject: (sessionId) => ({ remote, sessionId, sessions }) }, TavernHeaderChip);
    // D. 新会话英雄区：芯片并入 workspace 行，开场白预览挂在输入框上方
    mount('conversation.input.dock', { id: 'tavern-hero-character', order: -20, inject: (sessionId) => ({ remote, sessionId, sessions }) }, TavernHeroCharacter);
    // E. 对话区 assistant 消息：只在当前会话是 Tavern 时覆盖原生节点，否则卸掉让 dsh 自己画。
    ctx.effect(() => {
        let nodeDispose;
        const applyNode = (want) => {
            if (want) {
                if (nodeDispose)
                    return;
                nodeDispose = ctx.slots.register({
                    name: 'conversation.chat.node',
                    key: 'assistant-step',
                    priority: -1,
                    inject: (sessionId) => ({ remote, sessionId, sessions }),
                }, TavernAssistantNode);
            }
            else if (nodeDispose) {
                nodeDispose();
                nodeDispose = undefined;
            }
        };
        const sync = () => applyNode(isCurrentTavernSession(ctx.sessions.list));
        if (typeof ctx.slots.inject === 'function') {
            return ctx.slots.inject('conversation.chat.node', () => {
                const unsub = ctx.sessions.list.subscribe(sync);
                sync();
                return () => {
                    unsub();
                    applyNode(false);
                };
            });
        }
        const unsub = ctx.sessions.list.subscribe(sync);
        sync();
        return () => {
            unsub();
            applyNode(false);
        };
    }, 'dsh-tavern: assistant-step');
}
