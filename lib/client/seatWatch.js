/** 与 presets/tavern/preset.yml 的 name 保持一致。 */
const TAVERN_SEAT_LABEL = 'Tavern 模式';
/** 宿主 seatHint 的中英文案（dsh-client-ui-agent-preset 的 locale 表）。 */
const SEAT_HINTS = ['即将开始的这个会话所用的 Agent 预设', 'Agent preset for the session you are about to start'];
/** seat chip 当前是否显示 Tavern 预设；null = chip 尚未渲染（含 title 被错误信息顶替）。 */
function seatShowsTavern() {
    const chips = document.querySelectorAll('button[aria-haspopup="menu"]');
    for (let i = 0; i < chips.length; i++) {
        const chip = chips[i];
        if (chip && SEAT_HINTS.includes(chip.getAttribute('title') ?? '')) {
            return (chip.textContent ?? '').includes(TAVERN_SEAT_LABEL);
        }
    }
    return null;
}
/** 安装监听；返回清理函数（挂进 ctx.effect）。 */
export function installTavernSeatWatch(ctx) {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
        return () => { };
    }
    let baselineDone = false;
    let lastTavern = false;
    let coolingDown = false;
    let timer;
    let observer;
    const check = () => {
        timer = undefined;
        const tavern = seatShowsTavern();
        if (tavern === null)
            return; // chip 不在树上：保持上次状态，不算变化
        if (!baselineDone) {
            // 首次只建基线：刷新页面且 tavern 本就是默认预设时不能自动开会话。
            baselineDone = true;
            lastTavern = tavern;
            return;
        }
        if (tavern === lastTavern)
            return;
        lastTavern = tavern;
        if (!tavern || coolingDown)
            return;
        if (ctx.sessions.list.getSnapshot().current !== undefined)
            return; // 已有会话：宿主自己会处理
        coolingDown = true;
        setTimeout(() => {
            coolingDown = false;
        }, 1500);
        try {
            ctx.workspaces.startSession();
        }
        catch {
            // 与宿主「新对话」一致：失败静默（无工作区/基线未就绪），用户仍可手动点。
        }
    };
    // 流式输出期间 DOM 变动频繁，合并到一个短窗口内检查一次。
    const schedule = () => {
        if (timer !== undefined)
            return;
        timer = setTimeout(check, 200);
    };
    const start = () => {
        if (observer || !document.body)
            return;
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        schedule(); // 建立基线
    };
    if (document.body)
        start();
    else
        document.addEventListener('DOMContentLoaded', start, { once: true });
    return () => {
        document.removeEventListener('DOMContentLoaded', start);
        observer?.disconnect();
        if (timer !== undefined)
            clearTimeout(timer);
    };
}
