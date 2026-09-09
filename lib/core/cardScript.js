export function installCardScript(context) {
    const root = window;
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const { script } = context;
    let buttons = clone(script.button.buttons), info = script.info, revision = 0, active = true;
    root.__dshTavernScriptId = script.id;
    const ready = async () => {
        if (document.readyState === 'loading')
            await new Promise(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
        if (root.__dshTavernScriptFailure)
            throw new Error(String(root.__dshTavernScriptFailure));
        const jquery = root.jQuery;
        if (jquery?.ready)
            await jquery.ready;
        // 等待此前注册的 DOM ready 回调；脚本中的额外异步初始化仍须由模块顶层 await。
        await new Promise(resolve => setTimeout(resolve, 0));
        const flush = root.flushHelperVariables;
        if (typeof flush === 'function')
            await flush();
        if (!active)
            throw new Error('脚本已停止');
        if (root.__dshTavernScriptFailure)
            throw new Error(String(root.__dshTavernScriptFailure));
        parent.postMessage({ source: 'dsh-tavern-card', action: 'helperScriptReady', runtimeId: root.__dshTavernEventRuntimeId, scriptId: script.id, ok: true }, '*');
    };
    root.__dshTavernScriptReady = ready;
    const emit = root.eventEmit;
    const report = (error) => { const callback = root.__dshTavernReportError; if (typeof callback === 'function')
        callback(error); };
    const getButtonEvent = (name) => `dsh_script_button:${JSON.stringify([script.id, name])}`;
    function validate(value) {
        if (!Array.isArray(value) || value.length > 64)
            throw new Error('脚本按钮必须是至多 64 项的数组');
        const seen = new Set();
        return value.map(button => {
            if (!button || typeof button.name !== 'string' || !button.name || button.name.length > 256 || typeof button.visible !== 'boolean' || seen.has(button.name))
                throw new Error('脚本按钮名称或可见性无效');
            seen.add(button.name);
            return { name: button.name, visible: button.visible };
        });
    }
    function render() {
        if (!active || !document.body)
            return;
        let node = document.getElementById('dsh-tavern-script-buttons');
        if (!node) {
            node = document.createElement('div');
            node.id = 'dsh-tavern-script-buttons';
            document.body.prepend(node);
        }
        node.replaceChildren();
        if (!script.button.enabled)
            return;
        for (const button of buttons.filter(item => item.visible)) {
            const element = document.createElement('button');
            element.type = 'button';
            element.id = getButtonEvent(button.name);
            element.textContent = button.name;
            element.onclick = () => { void emit(getButtonEvent(button.name)).catch(report); };
            node.append(element);
        }
    }
    function persist(change) {
        if (!root.__dshTavernScriptLibrariesInstalled)
            return;
        const update = root.updateScriptTreesWith;
        if (typeof update !== 'function' || !context.libraryType)
            throw new Error('脚本未绑定可写资产库');
        update((trees) => {
            let found = false;
            const apply = (value) => { if (value.id !== script.id)
                return value; found = true; return change(value); };
            const result = trees.map(tree => tree.type === 'script' ? apply(tree) : { ...tree, scripts: tree.scripts.map(apply) });
            if (!found)
                throw new Error('当前脚本已被删除，请重新加载');
            return result;
        }, { type: context.libraryType });
    }
    function replaceScriptButtons(value) {
        if (!active)
            throw new Error('脚本已停止');
        const next = validate(value);
        persist(value => ({ ...value, button: { ...value.button, buttons: next } }));
        buttons = next;
        revision++;
        render();
    }
    function updateScriptButtonsWith(updater) {
        const before = revision;
        const value = updater(clone(buttons));
        const commit = (next) => { if (revision !== before)
            throw new Error('脚本按钮已改变'); replaceScriptButtons(next); return clone(buttons); };
        return value && typeof value.then === 'function' ? Promise.resolve(value).then(commit) : commit(value);
    }
    function setMessageChoices(messageId, choices) {
        if (!active || !Number.isSafeInteger(messageId) || messageId < 0 || !Array.isArray(choices) || choices.length > 32)
            throw new Error('选项参数无效');
        const snapshot = root.__dshTavernSnapshot;
        if (!snapshot)
            throw new Error('选项需要当前剧情快照');
        const items = choices.map(item => { if (!item || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 128 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 1024)
            throw new Error('选项文本无效'); return { label: item.label, text: item.text }; });
        parent.postMessage({ source: 'dsh-tavern-card', action: 'helperScriptChoices', runtimeId: root.__dshTavernEventRuntimeId, storyId: snapshot.storyId, historyRevision: snapshot.historyRevision, messageId, choices: items }, '*');
    }
    const api = { setMessageChoices, getScriptId: () => script.id, getScriptName: () => script.name, getScriptInfo: () => info,
        replaceScriptInfo: (value) => { if (!active || typeof value !== 'string' || value.length > 64 * 1024)
            throw new Error('脚本说明无效或脚本已停止'); persist(script => ({ ...script, info: value })); info = value; },
        getIframeName: () => `TH-script--${script.id}`, getButtonEvent, getScriptButtons: () => clone(buttons), replaceScriptButtons, updateScriptButtonsWith,
        appendInexistentScriptButtons: (value) => { const parsed = validate(value); replaceScriptButtons([...buttons, ...parsed.filter(item => !buttons.some(old => old.name === item.name))]); },
        getScriptTrees: (option) => {
            if (!['global', 'preset', 'character'].includes(option?.type))
                throw new Error('脚本库类型无效');
            if (context.libraries)
                return clone(context.libraries.find(library => library.type === option.type)?.trees ?? []);
            if (option.type === 'character')
                return clone(context.trees);
            throw new Error('此脚本快照未包含目标脚本库');
        },
    };
    if (root.__dshTavernScriptLibrariesInstalled)
        delete api.getScriptTrees;
    Object.assign(root, api);
    root.TavernHelper = Object.assign(root.TavernHelper ?? {}, api);
    const insert = root.insertVariables;
    const holder = root.__dshTavernVariables;
    if (typeof insert === 'function' && !Object.hasOwn(holder.scopes, JSON.stringify(['script', script.id])))
        insert(script.data, { type: 'script', script_id: script.id });
    document.addEventListener('DOMContentLoaded', render, { once: true });
    if (document.readyState !== 'loading')
        render();
    return () => { active = false; if (root.__dshTavernScriptReady === ready)
        delete root.__dshTavernScriptReady; document.removeEventListener('DOMContentLoaded', render); };
}
/** 用可信脚本创建内联 module 元素，JSON 编码避免正文中的结束标签逃出容器；模块网络仍受现有 CSP 限制。 */
export function helperScriptHtml(content) {
    const executable = isNativeMvuFramework(content) ? "await waitGlobalInitialized('Mvu');" : content;
    const encoded = JSON.stringify(executable + '\n;await window.__dshTavernScriptReady();').replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `<script>var dshScript=document.createElement('script');dshScript.type='module';dshScript.textContent=${encoded};document.head.append(dshScript);</script>`;
}
/** 仅识别纯官方 MVU 框架导入入口，交给已有原生 MVU；其它代码完整保留，不伪造父窗口。 */
export function isNativeMvuFramework(content) {
    const source = content.trim().replace(/;$/, '').trim();
    return ['testingcf.jsdelivr.net', 'cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'gcore.jsdelivr.net'].some(host => ["'", '"'].some(quote => source === 'import ' + quote + 'https://' + host + '/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js' + quote));
}
