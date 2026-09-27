/** 自包含函数注入 opaque iframe；不加载原版主窗口脚本，不自动改写正文或发起模型请求。 */
export function installCardMvu(codec, json) {
    const root = window;
    let active = true, parsing = 0;
    const events = Object.freeze({
        // 与官方 MVU variable_events 同名；缺项会让 eventOn(Mvu.events.X) 在卡面脚本顶层抛错。
        SINGLE_VARIABLE_UPDATED: 'mag_variable_updated',
        VARIABLE_INITIALIZED: 'mag_variable_initialized', VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
        COMMAND_PARSED: 'mag_command_parsed', VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
        BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    });
    const check = () => { if (!active)
        throw new Error('MVU 卡面已关闭或重写'); };
    function table(value) {
        const result = json(value);
        if (!result || typeof result !== 'object' || Array.isArray(result))
            throw new Error('MVU 数据必须是普通 JSON 对象');
        return result;
    }
    function data(value) {
        const result = table(value);
        if (!result.stat_data || typeof result.stat_data !== 'object' || Array.isArray(result.stat_data))
            throw new Error('MVU 数据缺少 stat_data 对象');
        if (Object.hasOwn(result.stat_data, '$internal'))
            throw new Error('MVU 临时 $internal 数据不能保存或返回');
        return result;
    }
    function supported(value) {
        if (value.schema !== undefined && value.schema !== '没有用别管这个')
            throw new Error('当前 MVU 适配尚不支持 classic schema 或未知 schema；请使用 Zod 命令处理或普通变量数据');
        function walk(item) {
            if (item === '$__META_EXTENSIBLE__$')
                throw new Error('当前 MVU 适配尚不支持 classic schema 元数据');
            if (!item || typeof item !== 'object')
                return;
            for (const [key, child] of Object.entries(item)) {
                if (['$internal', '$meta', '$arrayMeta'].includes(key))
                    throw new Error('当前 MVU 适配尚不支持 classic schema 元数据或临时字段');
                walk(child);
            }
        }
        walk(value.stat_data);
    }
    function getMvuData(option) {
        check();
        return root.getVariables(option);
    }
    async function replaceMvuData(value, option) {
        check();
        const next = data(value);
        root.replaceVariables(next, option);
        const flush = root.flushHelperVariables;
        if (typeof flush === 'function')
            await flush();
        check();
    }
    /** 合并单条命令的变更日志；数组下标的 null 只是占位，不能覆盖前面命令写下的日志。 */
    function mergeLog(target, source) {
        for (const [key, value] of Object.entries(source)) {
            if (value === null && Array.isArray(source))
                continue;
            const current = target[key];
            if (value && typeof value === 'object' && current && typeof current === 'object' && Array.isArray(value) === Array.isArray(current))
                mergeLog(current, value);
            else
                target[key] = value && typeof value === 'object' ? json(value) : value;
        }
    }
    async function emit(name, ...args) {
        check();
        json(args, 256 * 1024);
        await root.eventEmit(name, ...args);
        check();
        json(args, 256 * 1024);
    }
    async function parseMessage(message, oldData) {
        check();
        if (parsing >= 8)
            throw new Error('MVU 解析超过并发预算');
        const before = data(oldData), next = data(before), commands = codec.parse(message);
        parsing++;
        try {
            // Zod 扩展可在命令阶段处理并移除命令；每个异步事件的原对象修改都在下一阶段可见。
            next.display_data = table(next.stat_data);
            next.delta_data = {};
            await emit(events.VARIABLE_UPDATE_STARTED, next);
            await emit(events.COMMAND_PARSED, next, commands, message);
            await emit('mag_command_parsed_for_zod', next, commands, message);
            await emit('mag_command_parsed_ended_for_zod', next, commands, message);
            if (commands.length) {
                supported(next);
                // 逐条应用：每条 set/add 后按官方 MVU 发出 SINGLE_VARIABLE_UPDATED(stat_data, 路径, 旧值, 新值)，
                // 监听器对 stat_data 的修改在下一条命令前生效。无监听时结果与整批应用相同；任一条失败整体拒绝。
                let display = table(next.display_data);
                const delta = {};
                for (const command of commands) {
                    const stat = table(data(next).stat_data), before = codec.read(stat, command.args[0]);
                    const applied = codec.apply(stat, [command], display);
                    display = applied.display_data;
                    mergeLog(delta, applied.delta_data);
                    next.stat_data = applied.stat_data;
                    next.display_data = display;
                    next.delta_data = delta;
                    if (command.type === 'set' || command.type === 'add') {
                        const raw = String(command.args[0]).trim(), quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
                        await emit(events.SINGLE_VARIABLE_UPDATED, next.stat_data, quoted ? quoted[2] : raw, before, codec.read(table(next.stat_data), command.args[0]));
                    }
                }
                next.delta_data = table(delta);
            }
            await emit(events.VARIABLE_UPDATE_ENDED, next, before);
            await emit('mag_variable_update_ended_for_zod', next, before);
            // 与当前 MVU 实现一致，无命令也返回独立副本；解析本身不落盘。
            const result = data(next);
            supported(result);
            return result;
        }
        finally {
            parsing--;
        }
    }
    async function initialize(value, swipeId) {
        const next = data(value);
        await emit(events.VARIABLE_INITIALIZED, next, swipeId);
        const result = data(next);
        supported(result);
        return result;
    }
    root.__dshTavernMvuInitialize = initialize;
    const mvu = Object.freeze({ events, getMvuData, replaceMvuData, parseMessage, isDuringExtraAnalysis: () => { check(); return false; } });
    root.Mvu = mvu;
    // 原版依赖 parent.Mvu 的发布方式不适用于不透明源；内置对象在每个沙箱独立安装。
    async function waitGlobalInitialized(name) {
        check();
        if (name !== 'Mvu')
            throw new Error('跨沙箱全局接口尚未适配：' + String(name).slice(0, 128));
        return mvu;
    }
    root.waitGlobalInitialized = waitGlobalInitialized;
    root.TavernHelper = Object.assign(root.TavernHelper ?? {}, { waitGlobalInitialized });
    return () => {
        active = false;
        if (root.Mvu === mvu)
            delete root.Mvu;
        if (root.__dshTavernMvuInitialize === initialize)
            delete root.__dshTavernMvuInitialize;
        if (root.waitGlobalInitialized === waitGlobalInitialized)
            delete root.waitGlobalInitialized;
        const helper = root.TavernHelper;
        if (helper?.waitGlobalInitialized === waitGlobalInitialized)
            delete helper.waitGlobalInitialized;
    };
}
