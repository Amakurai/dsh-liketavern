/**
 * 世界书触发引擎（纯函数），语义对齐 SillyTavern World Info：
 * - 触发键：明文键 + `/regex/flags` 键；大小写敏感、整词匹配全局/条目级覆盖。
 *   键与扫描文本中的 `{{user}}`/`{{char}}` 先展开再匹配（对齐 ST substituteParams）。
 * - 次级键：AND ANY / AND ALL / NOT ANY / NOT ALL（selectiveLogic 0/3/2/1）。
 * - 触发策略：🔵 constant、🟢 关键词；🔗 向量匹配不做（由记忆 BM25 层承担，见 README）。
 * - 条目级 scanDepth：null 跟随全局；0 = 该条关键词不扫消息（常驻/递归/sticky 仍可活）。
 * - inclusion group：同组只留一条。sticky 延续占用组；否则 groupOverride 优先，
 *   useGroupScoring 可逐条覆盖全局：计分低于组内最高分的启用条目先淘汰，再按 override/权重选择。每轮即时裁决：
 *   落选条目的正文不喂给后续递归轮次、不进最终输出；后续轮新激活的组员与现任胜者
 *   重新角逐，可以翻盘（如递归层才命中的 override 条目）。
 * - 递归扫描：excludeRecursion（不可被递归激活）/ preventRecursion（激活后不触发他人）/
 *   delayUntilRecursion（递归层级门槛，0=首轮即可）；maxRecursionSteps 0=不限（仅受预算限制）、
 *   1=关闭、n=总扫描轮数（含首轮）。
 * - 定时效果：sticky / cooldown / delay，按评估轮（每次引擎调用 = 一轮）推进；
 *   swipe/重新生成/回退的回滚由事务层负责（plan 3.11），引擎本身无副作用。
 * - 预算：固定 token 为本轮世界书层的绝对上限；Context % 按窗口折算（基数 clamp 到
 *   128K 量级，见 turnBudget.ts）并扣减 reservedTokens；截断优先级：constant 优先 → order 从大到小 → 直接命中优先于递归命中；
 *   ignoreBudget 条目豁免。落 standing 的常驻条目（constant 且无本轮宏，isStandingSafeEntry）
 *   豁免计费——它们走钉死的 system 段、命中前缀缓存，不占未缓存尾巴；被裁条目进
 *   truncated 清单，渲染侧在快照尾部附 uid 供模型按条补读。
 * - 多来源合并：Chat > Persona > Character/Global（strategy: 0 evenly / 1 character_first / 2 global_first），
 *   delta 变化层与 character 同级（紧随原书条目之后，由渲染侧标注「当前状态」）。
 * - 键安全：纯引擎同步执行；host 调用须放在有超时的 worker。超长键（> MAX_WI_KEY_CHARS）与含灾难性回溯构造的
 *   /regex/ 键（复用 regex.ts 的保守启发式）一律按「永不命中」处理，与非法正则键同口径。
 */
import { expandIdentityMacros, hasTurnLocalMacros } from './macros.js';
import { findUnsafeRegexConstruct } from './regex.js';
import { WI_PERCENT_WINDOW_BASE } from './turnBudget.js';
import { DEFAULT_WI_SETTINGS, WIPosition, WISelectiveLogic, } from './types.js';
const REGEX_KEY_RE = /^\/(.*)\/([a-z]*)$/s;
/**
 * 触发键字符数硬上限（归一化侧 state/lorebook.ts 导入共用，集中在此定义）：
 * 正常键是短语、正则键也在百级；超长键的扫描/回溯成本不可控。
 * 引擎侧超限键按「永不命中」处理（与非法正则键同口径），归一化侧直接拒绝导入。
 */
export const MAX_WI_KEY_CHARS = 500;
/**
 * 条目是否确定常驻：无本轮宏、概率、分组或定时条件。与 assemble 的渲染分流
 * 共用同一判定，两处不得漂移。standing 侧条目豁免 turn 层预算（走钉死的 system 段，
 * 命中前缀缓存；live 通道体积由 node/pipeline 单独检查）。
 */
export function isStandingSafeEntry(entry) {
    return entry.constant && !hasTurnLocalMacros(entry.content)
        && (!entry.useProbability || entry.probability >= 100) && !entry.group
        && !(entry.sticky && entry.sticky > 0) && !(entry.cooldown && entry.cooldown > 0)
        && !(entry.delay && entry.delay > 0) && entry.delayUntilRecursion === 0
        && entry.source !== 'delta'
        && entry.position !== WIPosition.AuthorNoteTop && entry.position !== WIPosition.AuthorNoteBottom && entry.position !== WIPosition.Outlet;
}
function ident(text, ctx) {
    return ctx ? expandIdentityMacros(text, ctx) : text;
}
/** 单条触发键编译：返回 (text) => boolean。明文键支持整词/大小写选项；/.../ 为 JS 正则键。 */
function compileKey(key, options) {
    const trimmed = key.trim();
    if (!trimmed)
        return null;
    // 超长键永不命中（防 DoS；归一化侧 lorebook.ts 同值直接拒绝导入）
    if (trimmed.length > MAX_WI_KEY_CHARS)
        return null;
    const literal = REGEX_KEY_RE.exec(trimmed);
    if (literal) {
        // 灾难性回溯构造（(a+)+$ 类）在主事件循环上会冻结整个 host：与非法正则同口径，永不命中
        if (findUnsafeRegexConstruct(literal[1]) !== null)
            return null;
        try {
            const re = new RegExp(literal[1], literal[2] ?? '');
            // `g`/`y` 正则的 test() 会保留 lastIndex。世界书会对同一条键
            // 连续扫描多个消息/名称变体，若不复位，命中结果会在奇偶次调用间
            // 交替漏掉。每次判断都从头开始，保持条目匹配的纯函数语义。
            return (text) => {
                re.lastIndex = 0;
                return re.test(text);
            };
        }
        catch {
            return null; // 非法正则键视为永不命中
        }
    }
    let needle = trimmed;
    if (!options.caseSensitive)
        needle = needle.toLowerCase();
    if (options.matchWholeWords) {
        try {
            const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`\\b${escaped}\\b`, options.caseSensitive ? '' : 'i');
            return (text) => re.test(text);
        }
        catch {
            return null;
        }
    }
    return (text) => (options.caseSensitive ? text : text.toLowerCase()).includes(needle);
}
/** 扫描单元：把消息拍平成可匹配的文本（含名前缀变体）。 */
function scanTexts(messages, includeNames, macroCtx) {
    const out = [];
    for (const msg of messages) {
        const content = ident(msg.content, macroCtx);
        out.push(content);
        if (includeNames && msg.name) {
            out.push(`${msg.name}: ${content}`);
            // 兼容 SillyTavern 的 \x01Name: 前缀匹配
            out.push(`\x01${msg.name}: ${content}`);
        }
    }
    return out;
}
function compileEntry(entry, settings, macroCtx) {
    const opts = {
        caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
        matchWholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
    };
    // 防御绕过归一化（parseLorebook）的调用方：keys 非数组/含非字符串时
    // 直接在 .map/.trim 处炸在主循环里，这里塌缩成可安全跳过的形态
    const rawKeys = Array.isArray(entry.keys) ? entry.keys.filter((k) => typeof k === 'string') : [];
    const rawSecondary = Array.isArray(entry.secondaryKeys)
        ? entry.secondaryKeys.filter((k) => typeof k === 'string')
        : [];
    const primary = rawKeys
        .map((k) => ({ raw: k, test: compileKey(ident(k, macroCtx), opts) }))
        .filter((k) => k.test !== null);
    const secondary = rawSecondary
        .map((k) => compileKey(ident(k, macroCtx), opts))
        .filter((t) => t !== null);
    return { entry, primary, secondary };
}
function matchCompiled(c, texts) {
    const matched = [];
    for (const k of c.primary) {
        if (texts.some((t) => k.test(t)))
            matched.push(k.raw);
    }
    if (matched.length === 0)
        return null;
    const entry = c.entry;
    if (!entry.selective || entry.secondaryKeys.length === 0)
        return matched;
    const hits = c.secondary.filter((test) => texts.some((t) => test(t))).length;
    const ok = entry.selectiveLogic === WISelectiveLogic.AndAny
        ? hits > 0
        : entry.selectiveLogic === WISelectiveLogic.AndAll
            ? hits === c.secondary.length
            : entry.selectiveLogic === WISelectiveLogic.NotAny
                ? hits === 0
                : hits < c.secondary.length; // NotAll
    return ok ? matched : null;
}
function textsAtDepth(cache, messages, depth, includeNames, macroCtx) {
    if (depth <= 0)
        return [];
    const cached = cache.get(depth);
    if (cached)
        return cached;
    const texts = scanTexts(messages.slice(-depth), includeNames, macroCtx);
    cache.set(depth, texts);
    return texts;
}
/** 组内加权随机挑选（groupWeight 为权重；全零权重取第一条）。 */
function pickGroupWeighted(pool, random) {
    const weights = pool.map((c) => Math.max(0, c.entry.groupWeight));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0)
        return pool[0];
    let cursor = random() * total;
    for (let i = 0; i < pool.length; i++) {
        cursor -= weights[i];
        if (cursor < 0)
            return pool[i];
    }
    return pool[pool.length - 1];
}
/** 多来源合并排序权重：tier 小者先插入（越远离上下文末端）。 */
function sourceTier(entry, strategy) {
    switch (entry.source) {
        case 'chat':
            return 0;
        case 'persona':
            return 1;
        case 'character':
            return strategy === 0 ? 2 : strategy === 2 ? 3 : 2;
        case 'global':
            return strategy === 0 ? 2 : strategy === 2 ? 2 : 3;
        case 'delta':
            return strategy === 0 ? 2 : strategy === 2 ? 3 : 2; // delta 与 character 同级
    }
}
/**
 * 求值一轮世界书触发。返回激活条目（按位置分桶）、触发日志与新的定时状态。
 * 纯函数：不修改入参；timerState 的持久化由调用方经事务层完成。
 */
export function evaluateWorldInfo(input) {
    const settings = { ...DEFAULT_WI_SETTINGS, ...input.settings };
    const random = input.random ?? Math.random;
    const log = [];
    const timer = {
        stickyLeft: { ...input.timerState.stickyLeft },
        cooldownLeft: { ...input.timerState.cooldownLeft },
    };
    // ── 定时效果按轮推进：本轮判定使用上轮剩余值，轮末才扣减（见递归扫描之后）。
    // sticky=N 语义 = 激活后再保持 N 轮（types.ts：「激活后保持 N 条消息」）；
    // 若轮初先扣，sticky=2 只会多维持 1 轮，与文档语义不符。
    const stickyKeysAtStart = new Set(Object.keys(timer.stickyLeft));
    const cooldownKeysAtStart = new Set(Object.keys(timer.cooldownLeft));
    const entries = input.entries.filter((e) => {
        if (!e.enabled) {
            log.push({ kind: 'disabled', entryKey: e.key, detail: e.comment || e.key });
            return false;
        }
        return true;
    });
    // 键预编译一次，全部递归轮复用（compileEntry 不消费 random，加权随机的消费顺序不受影响）。
    const compiled = entries.map((entry) => compileEntry(entry, settings, input.macroCtx));
    // 扫描文本：全局/条目 scanDepth 0 = 该条关键词不扫消息（常驻与递归仍可活）
    const depthTexts = new Map();
    const activated = [];
    const activatedKeys = new Set();
    const probabilityFailures = new Set();
    let expandedDepth = settings.scanDepth;
    let recursionQueue = [];
    // inclusion group 即时裁决状态：组名 → 当前胜者（sticky 占用时可多条）；落选者进 groupLosers
    const groupWinners = new Map();
    const groupLosers = new Set();
    /**
     * 每轮扫描结束后立刻裁决 inclusion group。落选者的正文不喂给后续递归轮次、
     * 不进最终输出——不再让「自己不会被注入的条目」决定别人是否被递归激活。
     * 裁决口径与历史「全量激活后一次性裁决」一致：sticky 延续占用组 > groupOverride >
     * useGroupScoring（命中键数）/ groupWeight 加权随机。后续轮新激活的组员与现任胜者
     * 重新角逐，可以翻盘（如递归层才命中的 override 条目）；跨轮激活的组会多次消费
     * random()——与旧单次裁决的消费顺序不同，是本次对齐语义的既定变化。
     */
    const adjudicateGroups = (fresh) => {
        const newcomers = new Map();
        for (const c of fresh) {
            const name = typeof c.entry.group === 'string' ? c.entry.group.trim() : '';
            if (!name || groupLosers.has(c.entry.key))
                continue;
            const list = newcomers.get(name) ?? [];
            list.push(c);
            newcomers.set(name, list);
        }
        for (const [group, members] of newcomers) {
            const incumbents = groupWinners.get(group) ?? [];
            const pool = [...incumbents, ...members];
            const sticky = pool.filter((m) => m.via === 'sticky');
            let winners;
            if (sticky.length > 0) {
                winners = sticky;
            }
            else if (pool.length === 1) {
                winners = pool; // 单成员组不消耗 random（与旧行为逐字节一致）
            }
            else {
                // 只淘汰启用计分且低于组内最高分的条目；显式关闭计分的条目仍可参与权重选择。
                const maxScore = Math.max(...pool.map(candidate => candidate.matchedKeys.length));
                const scored = pool.filter(candidate => !(candidate.entry.useGroupScoring ?? settings.useGroupScoring) || candidate.matchedKeys.length === maxScore);
                const overrides = scored.filter((m) => m.entry.groupOverride);
                const contenders = overrides.length > 0 ? overrides : scored;
                winners = [contenders.length === 1 ? contenders[0] : pickGroupWeighted(contenders, random)];
            }
            groupWinners.set(group, winners);
            const winnerKeys = new Set(winners.map((w) => w.entry.key));
            for (const member of pool) {
                if (winnerKeys.has(member.entry.key) || groupLosers.has(member.entry.key))
                    continue;
                groupLosers.add(member.entry.key);
                log.push({
                    kind: 'group-skip',
                    entryKey: member.entry.key,
                    detail: sticky.length > 0 ? `组「${group}」由 sticky 延续占用` : `组「${group}」已选 ${winners[0].entry.key}`,
                });
            }
        }
    };
    const tryActivate = (entry, matchedKeys, via, level) => {
        if (activatedKeys.has(entry.key) || probabilityFailures.has(entry.key))
            return false;
        // 只有 sticky 延续豁免概率。确定常驻条目本来就没有概率过滤，概率型 constant 必须按轮评估。
        if (via !== 'sticky' && entry.useProbability && entry.probability < 100) {
            if (random() * 100 >= entry.probability) {
                probabilityFailures.add(entry.key);
                log.push({ kind: 'probability-skip', entryKey: entry.key, detail: `probability=${entry.probability}` });
                return false;
            }
        }
        activated.push({ entry, matchedKeys, via, recursionLevel: level });
        activatedKeys.add(entry.key);
        log.push({
            kind: 'activated',
            entryKey: entry.key,
            detail: `via=${via} level=${level} keys=[${matchedKeys.join(', ')}]`,
        });
        // 定时效果：仅新激活（非 sticky 延续）写入状态；效果期间重复命中不刷新
        if (via !== 'sticky') {
            if (entry.sticky && entry.sticky > 0)
                timer.stickyLeft[entry.key] = entry.sticky;
            // cooldown 与 sticky 串联：sticky 期间 cooldown 一并倒数
            if (entry.cooldown && entry.cooldown > 0)
                timer.cooldownLeft[entry.key] = entry.cooldown + (entry.sticky ?? 0);
        }
        return true;
    };
    const evaluate = (texts, level) => {
        const fresh = [];
        for (const c of compiled) {
            const entry = c.entry;
            if (activatedKeys.has(entry.key))
                continue;
            // 递归门槛
            if (level > 0 && entry.excludeRecursion)
                continue;
            if (entry.delayUntilRecursion > level)
                continue;
            // 条目编辑为确定常驻后，旧配置留下的计时器不能改变稳定段是否存在。
            if (isStandingSafeEntry(entry)) {
                delete timer.stickyLeft[entry.key];
                delete timer.cooldownLeft[entry.key];
                if (tryActivate(entry, [], 'constant', level))
                    fresh.push(activated[activated.length - 1]);
                continue;
            }
            // sticky 延续：无需命中、跳过概率（须先于 cooldown 判定：cooldown 与 sticky
            // 串联写入时 sticky 期间 cooldown 一并倒数，先判 cooldown 会拦死 sticky 延续）
            if ((timer.stickyLeft[entry.key] ?? 0) > 0) {
                if (tryActivate(entry, [], 'sticky', level))
                    fresh.push(activated[activated.length - 1]);
                continue;
            }
            // 冷却
            const cooldownLeft = timer.cooldownLeft[entry.key] ?? 0;
            if (cooldownLeft > 0) {
                log.push({ kind: 'cooldown-skip', entryKey: entry.key, detail: `剩余 ${cooldownLeft} 轮` });
                continue;
            }
            // delay：聊天记录不足 N 条不可激活
            if (entry.delay && entry.delay > 0 && input.messages.length < entry.delay) {
                log.push({ kind: 'delay-skip', entryKey: entry.key, detail: `需要 ${entry.delay} 条消息，当前 ${input.messages.length}` });
                continue;
            }
            if (entry.constant) {
                if (tryActivate(entry, [], 'constant', level))
                    fresh.push(activated[activated.length - 1]);
                continue;
            }
            if (entry.keys.length === 0)
                continue;
            const scanTextsForEntry = level === 0
                ? textsAtDepth(depthTexts, input.messages, entry.scanDepth ?? expandedDepth, settings.includeNames, input.macroCtx)
                : texts;
            const matched = matchCompiled(c, scanTextsForEntry);
            if (matched === null)
                continue;
            if (tryActivate(entry, matched, level === 0 ? 'keyword' : 'recursion', level)) {
                fresh.push(activated[activated.length - 1]);
            }
        }
        return fresh;
    };
    // ── 第 0 层：直接扫描（每条用自己的 scanDepth） ─────────────────────────
    let level = 0;
    let scanSteps = 1;
    recursionQueue = evaluate([], 0);
    adjudicateGroups(recursionQueue);
    // ── 递归扫描：新激活条目的内容成为下一轮扫描输入（inclusion group 落选者除外） ──
    const maxSteps = settings.maxRecursionSteps; // 0=不限（受条目数与预算收敛）；1=关闭；n=总扫描轮数（含首轮）
    const scanRecursion = () => {
        while (settings.recursiveScan &&
            recursionQueue.length > 0 &&
            (maxSteps === 0 || scanSteps < maxSteps)) {
            const stopped = recursionQueue.filter((c) => c.entry.preventRecursion && !groupLosers.has(c.entry.key));
            for (const c of stopped) {
                log.push({ kind: 'recursion-stop', entryKey: c.entry.key, detail: 'preventRecursion：内容不进入递归扫描' });
            }
            const recursionTexts = recursionQueue
                .filter((c) => !c.entry.preventRecursion && !groupLosers.has(c.entry.key))
                .map((c) => (typeof c.entry.content === 'string' ? ident(c.entry.content, input.macroCtx) : ''))
                .filter((t) => t.trim().length > 0);
            // 没有可递归文本就不消耗递归步数：空内容轮提前 break 时 level 不 +1，
            // 后续 minActivations 扩展轮的「总扫描轮数」预算不被空轮挤占。
            if (recursionTexts.length === 0)
                break;
            level += 1;
            scanSteps += 1;
            recursionQueue = evaluate(recursionTexts, level);
            adjudicateGroups(recursionQueue);
        }
    };
    scanRecursion();
    // 扩展历史与递归在同一次求值内运行：定时器只推进一次，概率失败不会随扩深反复掷骰。
    const expansionLimit = Math.min(input.messages.length, 1000, settings.maxScanDepth > 0 ? settings.maxScanDepth : 1000);
    const scanBudget = settings.tokenBudget > 0 ? settings.tokenBudget : Math.max(0, Math.floor(Math.min(input.contextWindowTokens, WI_PERCENT_WINDOW_BASE) * settings.contextPercent / 100) - Math.max(0, input.reservedTokens));
    const surviving = () => activated.filter(c => !groupLosers.has(c.entry.key));
    while (settings.minActivations > 0 && surviving().length < settings.minActivations && expandedDepth < expansionLimit && (maxSteps === 0 || scanSteps < maxSteps)) {
        const counted = surviving().filter(c => !isStandingSafeEntry(c.entry));
        if (counted.reduce((sum, c) => sum + input.estimateTokens(c.entry.content), 0) > scanBudget)
            break;
        expandedDepth++;
        scanSteps++;
        // 扩展轮是新的直接扫描：递归 level 归零重起，delayUntilRecursion 门槛与首轮路径
        // 同口径；scanSteps 独立累计初始扫描、扩深和递归，不能借层级归零重置总预算。
        level = 0;
        recursionQueue = evaluate([], 0);
        adjudicateGroups(recursionQueue);
        scanRecursion();
    }
    // ── 轮末扣减定时计数：仅扣轮初已存在的键；本轮新激活写入的值从下一轮开始倒数 ──
    for (const key of stickyKeysAtStart) {
        const left = (timer.stickyLeft[key] ?? 0) - 1;
        if (left <= 0)
            delete timer.stickyLeft[key];
        else
            timer.stickyLeft[key] = left;
    }
    for (const key of cooldownKeysAtStart) {
        const left = (timer.cooldownLeft[key] ?? 0) - 1;
        if (left <= 0)
            delete timer.cooldownLeft[key];
        else
            timer.cooldownLeft[key] = left;
    }
    // inclusion group 已在每轮扫描后即时裁决（见 adjudicateGroups）：最终候选 = 全部激活去掉落选者
    const grouped = activated.filter((c) => !groupLosers.has(c.entry.key));
    // ── 预算截断：constant 优先 → order 从大到小 → 直接命中优先于递归 ─────────
    // 固定 tokenBudget 是本轮世界书层的绝对上限：命中内容走 runtime context 快照，
    // 快照对新请求永远是未缓存前缀，每轮全价重付——必须有不随窗口缩水的硬顶。
    // 百分比预算保留「与其他内容分摊窗口」的 ST 语义（扣减 reservedTokens），
    // 但折算基数 clamp 到 WI_PERCENT_WINDOW_BASE：1M 窗口模型下 25% = 25 万 token
    // 形同虚设，实测能让单轮快照膨胀到 ~37k 字符。
    // 预算只约束搭快照通道的条目：standing 侧常驻豁免（见循环内注释）；被裁条目进
    // truncated，由渲染侧在快照尾部附 uid 清单（assemble.ts），模型可按条补读。
    const percentLimit = Math.max(0, Math.floor((Math.min(input.contextWindowTokens, WI_PERCENT_WINDOW_BASE) * settings.contextPercent) / 100) -
        Math.max(0, input.reservedTokens));
    const limit = settings.tokenBudget > 0 ? settings.tokenBudget : percentLimit;
    const sorted = [...grouped].sort((a, b) => {
        const ac = a.entry.constant ? 0 : 1;
        const bc = b.entry.constant ? 0 : 1;
        if (ac !== bc)
            return ac - bc;
        if (a.entry.order !== b.entry.order)
            return b.entry.order - a.entry.order;
        const ad = a.recursionLevel === 0 ? 0 : 1;
        const bd = b.recursionLevel === 0 ? 0 : 1;
        if (ad !== bd)
            return ad - bd;
        return a.entry.key.localeCompare(b.entry.key);
    });
    const kept = [];
    const truncated = [];
    let used = 0;
    let overflowed = false;
    for (const c of sorted) {
        // 落 standing 的常驻条目豁免计费：它们走钉死的 system 段、命中前缀缓存，
        // 不随快照每轮重付；体积由 assemble 的总窗口预算兜底（trimmedSections）。
        if (isStandingSafeEntry(c.entry)) {
            kept.push(c);
            continue;
        }
        const cost = input.estimateTokens(c.entry.content);
        if (!c.entry.ignoreBudget && used + cost > limit) {
            overflowed = true;
            truncated.push({
                uid: c.entry.uid,
                key: c.entry.key,
                label: c.entry.comment || c.entry.keys[0] || c.entry.uid,
            });
            log.push({ kind: 'budget-trim', entryKey: c.entry.key, detail: `需要 ${cost} tokens，剩余 ${limit - used}` });
            continue;
        }
        used += cost;
        kept.push(c);
    }
    if (overflowed && settings.overflowWarning) {
        log.push({ kind: 'budget-overflow', entryKey: '', detail: `世界书预算 ${limit} tokens 已耗尽，部分条目被截断` });
    }
    // ── 分桶落位：同位置按 order 升序（渲染时依此顺序，大 order 更靠近上下文末端） ──
    const byPosition = {};
    const outlets = {};
    const positioned = [...kept].sort((a, b) => {
        const ta = sourceTier(a.entry, settings.characterStrategy);
        const tb = sourceTier(b.entry, settings.characterStrategy);
        if (ta !== tb)
            return ta - tb;
        if (a.entry.order !== b.entry.order)
            return a.entry.order - b.entry.order;
        return a.entry.key.localeCompare(b.entry.key);
    });
    const injected = [];
    for (const c of positioned) {
        const activation = {
            entry: c.entry,
            matchedKeys: c.matchedKeys,
            via: c.via,
            recursionLevel: c.recursionLevel,
        };
        if (c.entry.position === WIPosition.Outlet) {
            const name = c.entry.outletName.trim();
            if (!name)
                continue // 无名 outlet 条目不注入（也不进 activated，与「丢弃」语义一致）
                ;
            (outlets[name] ??= []).push(activation);
        }
        else {
            ;
            (byPosition[c.entry.position] ??= []).push(activation);
        }
        injected.push(activation);
    }
    // ── 落选（含预算截断/无出口）条目本轮才写入的 sticky/cooldown 必须清掉：条目没被注入
    // 却留下定时状态，下一轮会经 via='sticky' 免概率回来并独占 inclusion group，饿死同组兄弟。
    const injectedKeys = new Set(injected.map((a) => a.entry.key));
    for (const candidate of activated) {
        if (injectedKeys.has(candidate.entry.key))
            continue;
        // sticky 延续条目（计时是更早轮写入的）本轮落选也要清 stickyLeft：保留会让它下轮
        // 经 via='sticky' 免概率回归并无条件占住 inclusion group，饿死同组兄弟后又可能被裁，
        // 导致 sticky 剩余轮数内整组零输出。cooldown 保留——落选不豁免冷却。
        if (candidate.via === 'sticky' || !stickyKeysAtStart.has(candidate.entry.key))
            delete timer.stickyLeft[candidate.entry.key];
        if (!cooldownKeysAtStart.has(candidate.entry.key))
            delete timer.cooldownLeft[candidate.entry.key];
    }
    return {
        activated: injected,
        byPosition,
        outlets,
        log,
        budget: { limit, used, overflowed },
        truncated,
        timerState: timer,
    };
}
