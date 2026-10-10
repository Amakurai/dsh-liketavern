/**
 * 记忆存储（MemoryStore）。
 * 每条记忆一个 md 文件：memory/<id>.md（YAML frontmatter + 正文），压缩归档移入 memory/archive/。
 * frontmatter 手写解析（零依赖，不引入 yaml 库）：字段行 `key: value`，数组用 JSON 行内式
 * （`tags: ["a","b"]`）。一切文件读写经 WorkspaceFs（事务层）；检索复用核心 BM25
 * （keys 权重 ×2 已在索引侧内建），search 支持半衰期时间衰减（ts 取 updated）。
 * 检索别名是派生数据，单独存在 memory/aliases.json，按正文指纹对应到记忆，只进检索索引、不进去重索引。
 */
import { createHash, randomBytes } from 'node:crypto';
import { Bm25Index } from '../core/bm25.js';
import { parseAliasFile, serializeAliasFile } from '../core/memoryAliases.js';
import { estimateTokens } from '../core/tokenize.js';
import { withWorkspaceLock } from './workspaceLock.js';
import { dirWrittenSince, openLedger, writtenSince } from './writeLedger.js';
/** 正文软上限（字）：超过不拒绝，write 返回值带 overLength: true，治理提示由工具层做。 */
export const MEMORY_BODY_SOFT_LIMIT = 200;
const MEMORY_DIR = 'memory';
const ARCHIVE_PREFIX = 'archive/';
const ARCHIVE_DIR = `${MEMORY_DIR}/archive`;
/** 检索别名文件。放在 memory/ 下：分支快照整目录复制记忆时会一并带走，不必在子剧情里重新生成。 */
const ALIAS_PATH = `${MEMORY_DIR}/aliases.json`;
const NO_ALIASES = new Map();
function sameStat(a, b) {
    return a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size;
}
function sameList(a, b) {
    return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((item, index) => item === b[index]));
}
// ---------------------------------------------------------------------------
// frontmatter 序列化 / 解析（手写；解析失败抛错，由 list/get 容错跳过坏文件）
// ---------------------------------------------------------------------------
/** 序列化为 md 文本：frontmatter 字段行 + 空行 + 正文，文件以单个换行结尾。 */
export function serializeMemory(meta, body) {
    // 标量值内的换行会破坏行式解析，序列化时压平
    const scalar = (value) => value.replace(/[\r\n]+/g, ' ').trim();
    return ([
        '---',
        `created: ${scalar(meta.created)}`,
        `updated: ${scalar(meta.updated)}`,
        `source_range: ${scalar(meta.sourceRange)}`,
        `tags: ${JSON.stringify(meta.tags)}`,
        `keys: ${JSON.stringify(meta.keys)}`,
        '---',
        '',
        body,
    ].join('\n') + '\n');
}
/**
 * 记忆 id 是否可作为 memory/ 下的单个文件名：不含路径分隔符、盘符、NUL，且不是 . 或 ..。
 * 只挡越出目录与 WAL 记不下来的形状；本类生成的 `m-<base36>-<hex>` 与手放的普通文件名都通过。
 */
export function isMemoryId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 255 && !/[\\/:\0]/.test(id) && id !== '.' && id !== '..';
}
/** 归档读取的并发上限：避免上千个来源同时占用文件句柄。 */
const SOURCE_READ_CONCURRENCY = 8;
function sourceFingerprintOf(files) {
    return JSON.stringify(files.map(([path, stat]) => [path, stat && [stat.mtimeMs, stat.size]]));
}
/**
 * 有界并发的有序映射。逐项保留成功或失败，由调用方按原顺序决定先报哪个错；
 * 出错后不再领取新任务，已领取的（下标必然更小或正在执行）照常收尾。
 */
async function settleLimited(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;
    let failed = false;
    const worker = async () => {
        while (!failed && next < items.length) {
            const index = next++;
            try {
                results[index] = { status: 'fulfilled', value: await task(items[index], index) };
            }
            catch (reason) {
                failed = true;
                results[index] = { status: 'rejected', reason };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
/** Windows 的文件名别名共用来源身份；条目本身保留原文件名，大小写敏感系统仍区分文件。 */
function memoryIdentity(id) { return process.platform === 'win32' ? id.toLowerCase() : id; }
/** 迭代展开摘要的完整叶来源；避免多代摘要递归爆栈，也拒绝循环来源伪装成独立事实。 */
function summarySourceIds(id, entries) {
    const leaves = new Set();
    const finished = new Set();
    const visiting = new Set();
    const pending = [{ id, exit: false }];
    while (pending.length > 0) {
        const next = pending.pop();
        const identity = memoryIdentity(next.id);
        if (next.exit) {
            visiting.delete(identity);
            finished.add(identity);
            continue;
        }
        if (finished.has(identity))
            continue;
        if (visiting.has(identity))
            throw new Error('记忆归并来源存在循环');
        const entry = entries.get(identity);
        if (!entry)
            throw new Error(`摘要来源 ${next.id} 缺失，无法保证检索完整性`);
        const sources = memorySourceIds(entry.sourceRange);
        if (!sources.length) {
            leaves.add(entry.id);
            finished.add(identity);
            continue;
        }
        visiting.add(identity);
        pending.push({ id: next.id, exit: true });
        for (const source of sources)
            pending.push({ id: source, exit: false });
    }
    return [...leaves].sort();
}
/** 来源格式共用入口：旧逗号列表继续可读，特殊文件名用独立 JSON 标记避免逗号与换行歧义。 */
export function isMemorySummary(sourceRange) {
    return /^(?:compress|merge)(?:-json)?:/.test(sourceRange);
}
export function memorySourceIds(sourceRange) {
    const match = /^(?:compress|merge)(-json)?:([\s\S]*)$/.exec(sourceRange);
    if (!match)
        return [];
    let ids;
    try {
        ids = match[1] ? JSON.parse(match[2]) : match[2].split(',');
    }
    catch {
        throw new Error('记忆归并来源格式损坏');
    }
    if (!Array.isArray(ids) || !ids.length || !ids.every(isMemoryId)) {
        throw new Error('记忆归并来源 id 非法');
    }
    return ids;
}
function memorySourceRange(kind, ids) {
    if (!ids.every(isMemoryId))
        throw new Error('记忆归并来源 id 非法');
    return ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))
        ? `${kind}:${ids.join(',')}`
        : `${kind}-json:${JSON.stringify(ids)}`;
}
/**
 * 解析 md 文本为 MemoryEntry。file 为相对 memory/ 目录的路径（如 `m-x.md`、`archive/m-x.md`）。
 * 缺少 frontmatter、created 缺失/非法、数组字段非 JSON 字符串数组时抛错。
 */
export function parseMemory(file, text) {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---')
        throw new Error(`记忆文件缺少 frontmatter: ${file}`);
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i] === '---') {
            end = i;
            break;
        }
    }
    if (end < 0)
        throw new Error(`记忆文件 frontmatter 未闭合: ${file}`);
    const fields = new Map();
    for (const line of lines.slice(1, end)) {
        if (!line.trim())
            continue;
        const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!match)
            throw new Error(`frontmatter 字段行无法解析: ${file}: ${line}`);
        fields.set(match[1], match[2]);
    }
    const created = fields.get('created') ?? '';
    if (!created || Number.isNaN(Date.parse(created))) {
        throw new Error(`记忆文件 created 缺失或非法: ${file}`);
    }
    const updatedRaw = fields.get('updated');
    const updated = updatedRaw && !Number.isNaN(Date.parse(updatedRaw)) ? updatedRaw : created;
    const parseArray = (raw) => {
        if (raw === undefined || raw.trim() === '')
            return [];
        const value = JSON.parse(raw);
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error(`frontmatter 数组字段非法: ${file}: ${raw}`);
        }
        return value;
    };
    const base = file.split('/').pop().replace(/\.md$/i, '');
    if (!base)
        throw new Error(`记忆文件名非法: ${file}`);
    const body = lines
        .slice(end + 1)
        .join('\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');
    return {
        id: base,
        file,
        created,
        updated,
        sourceRange: fields.get('source_range') ?? '',
        tags: parseArray(fields.get('tags')),
        keys: parseArray(fields.get('keys')),
        body,
        archived: file.startsWith(ARCHIVE_PREFIX),
    };
}
// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------
export class MemoryStore {
    fs;
    similarTopK;
    /**
     * 活跃记忆的解析结果，按目录指纹（文件名 + mtime + size）失效。
     *
     * 为什么以磁盘指纹为主、不只用进程内修订号（对比 TavernState 的 presetCache / loreCache）：
     * 记忆文件除了本类还会被 WAL 回滚直接写回磁盘（楼层回退撤销本轮 memory_write），修订号捕获不到那条路径，
     * 会让检索一直用回滚前的索引。指纹是每个文件一次 lstat（不读数据），比全文读 + 分词便宜一个量级。
     * 本类自己的写入另外记进同一剧情共享的写入登记（WriteLedger），补上指纹在同一时间刻度内分不出的情况。
     *
     * 缓存的收益点：一次 memory_write 要连着跑 findSimilar → stats → write，
     * 一个 turn 里 search 也可能被工具重复调用；没有缓存的话每次都全量重读 + 重建索引。
     */
    cache = null;
    /** 只含活跃记忆的索引（写入去重用）与含可达归档来源的索引（检索用）；只在工作区锁内读写。 */
    activeIndex = null;
    sourceIndex = null;
    /**
     * 活跃记忆逐个文件的解析结果（坏文件记为 null）。目录指纹变化时只重读指纹变了的文件：
     * 写一条记忆只多出一个文件，不必把其余上百条再读一遍。判断口径与目录指纹相同（文件名 + mtime + size）。
     */
    activeCache = new Map();
    /**
     * 已解析的归档来源，按路径存、按磁盘指纹校验，活跃集变化时不随 cache 一起丢弃。
     *
     * 归档原文写入后基本不再变化，而每次 memory_write 都会让活跃集指纹变化；没有这层的话，
     * 下一次检索要把全部可达来源重新逐个读盘（几百条来源即数百毫秒，随剧情长度线性增长）。
     * 信任程度与来源索引的缓存命中相同：每次对齐索引时仍批量核对指纹，指纹不符或文件缺失就重读或报错；
     * 显式 invalidate 会一并清空。
     */
    sourceCache = new Map();
    /** 别名文件的解析结果，按磁盘指纹与写入登记校验；文件不存在时记为空表。 */
    aliasCache = null;
    /** 条目正文的指纹；条目对象在正文不变时一直是同一个，不必每次重算。 */
    hashes = new WeakMap();
    ledger;
    epoch;
    constructor(fs, options) {
        this.fs = fs;
        this.similarTopK = options?.similarTopK ?? 3;
        // 同一剧情的多个实例（管线与工具的只读操作用长期存活的那个，工具写入每次新建）共用文件层的写入登记
        this.ledger = openLedger(fs.root);
        this.epoch = this.ledger.epoch;
    }
    /**
     * id 必须是单个文件名段。模型可以把任意字符串当 id 传进 update/delete：
     * `archive/x` 会绕过「去重只查活跃条目」改写归档来源，`./x` 能读到文件却会在 WAL 里留下
     * 日后无法读回的路径，让整个剧情的回退/分支失效。此处不区分归档与否统一拒绝。
     */
    pathOf(id, archived = false) {
        if (!isMemoryId(id))
            throw new Error(`记忆 id 非法: ${id}`);
        return `${MEMORY_DIR}/${archived ? ARCHIVE_PREFIX : ''}${id}.md`;
    }
    /**
     * 作废这个剧情下全部实例的缓存。平时不需要调用：本类的写入、面板编辑、WAL 回滚都经 WorkspaceFs，
     * 由文件层的写入登记通知各实例重读。只有完全绕过 WorkspaceFs 的改写（别的进程、外部编辑器、测试直接写盘）
     * 才可能既不改文件大小、又落在同一个 mtime 刻度内，那时需要调用方手动调一次。
     */
    invalidate() {
        this.ledger.epoch++;
        this.sync();
    }
    /** 取共享的写入登记；有实例显式作废过就先丢掉本实例的全部缓存。 */
    sync() {
        if (this.epoch !== this.ledger.epoch) {
            this.epoch = this.ledger.epoch;
            this.cache = null;
            this.activeIndex = null;
            this.sourceIndex = null;
            this.activeCache.clear();
            this.sourceCache.clear();
            this.aliasCache = null;
        }
        return this.ledger;
    }
    /** 正文指纹：别名按它对应到记忆，正文一改即作废。 */
    hashOf(entry) {
        let hash = this.hashes.get(entry);
        if (hash === undefined) {
            hash = createHash('sha256').update(entry.body).digest('hex').slice(0, 32);
            this.hashes.set(entry, hash);
        }
        return hash;
    }
    /**
     * 读别名文件；调用方必须持有工作区锁。文件缺失或损坏都当作没有别名——它是派生数据，之后会重新生成。
     * known 是调用方刚取到的磁盘指纹（与别的文件一起批量取的），传了就不再单独 stat。
     */
    async loadAliases(known) {
        const ledger = this.sync();
        const revision = ledger.counter;
        const stat = known !== undefined ? known : (await this.fs.statMany([ALIAS_PATH]))[0] ?? null;
        const cached = this.aliasCache;
        if (cached && sameStat(cached.stat, stat) && !writtenSince(ledger, ALIAS_PATH, cached.revision))
            return cached.records;
        const text = stat ? await this.fs.readText(ALIAS_PATH) : null;
        const records = text === null ? NO_ALIASES : parseAliasFile(text);
        this.aliasCache = { stat, revision, records };
        return records;
    }
    /** 这条记忆当前有效的别名：指纹与正文对得上、且不为空。 */
    aliasesOf(entry, records) {
        const record = records.get(entry.id);
        return record && record.aliases.length > 0 && record.hash === this.hashOf(entry) ? record.aliases : undefined;
    }
    /**
     * 还没有别名、或者别名已随正文改动作废的活跃记忆，最新的在前，最多 limit 条。
     * 生成过但模型没给出别名的条目记为空列表，不再重复请求。
     */
    async aliasCandidates(limit) {
        return withWorkspaceLock(this.fs.root, async () => {
            const entries = await this.listNow();
            const records = await this.loadAliases();
            const pending = [];
            for (let i = entries.length - 1; i >= 0 && pending.length < limit; i--) {
                const entry = entries[i];
                if (entry.body.trim() && records.get(entry.id)?.hash !== this.hashOf(entry))
                    pending.push(entry);
            }
            return pending;
        });
    }
    /**
     * 保存一批别名，返回实际保存的条数。等待模型期间被改写、删除或归并的记忆对不上现在的正文，直接跳过。
     * 别名是派生数据，只能经无楼层的文件面写入：记进楼层 WAL 的话，回退楼层会把别的记忆的别名一起改回去。
     * 顺带清掉既不在活跃库、也不在归档里的记录。
     */
    async saveAliases(items) {
        if (this.fs.currentFloor !== null)
            throw new Error('记忆别名是派生数据，不能在楼层内写入');
        return withWorkspaceLock(this.fs.root, async () => {
            const current = new Map((await this.listNow()).map((entry) => [entry.id, entry]));
            const records = new Map(await this.loadAliases());
            let saved = 0;
            for (const item of items) {
                const live = current.get(item.entry.id);
                if (!live || live.body !== item.entry.body)
                    continue;
                records.set(live.id, { hash: this.hashOf(live), aliases: [...item.aliases] });
                saved++;
            }
            if (saved === 0)
                return 0;
            const archived = new Set((await this.fs.list(ARCHIVE_DIR, { recursive: false }))
                .filter((name) => name.endsWith('.md')).map((name) => name.slice(0, -3)));
            for (const id of [...records.keys()])
                if (!current.has(id) && !archived.has(id))
                    records.delete(id);
            await this.fs.writeText(ALIAS_PATH, serializeAliasFile(records));
            return saved;
        });
    }
    /** 解析 memory/*.md（不含 archive/），坏文件容错跳过；按 created 升序（并列按 id 字典序）。 */
    async list() {
        return withWorkspaceLock(this.fs.root, () => this.listNow());
    }
    async listNow() {
        // 序号取在读盘之前：读盘期间别的实例写入的文件，下次仍会被判为需要重读。
        const ledger = this.sync();
        const revision = ledger.counter;
        // 非递归列举：archive/ 只增不查，递归会让每次检索的成本随归档量增长。
        const stats = await this.fs.listStats(MEMORY_DIR);
        const files = stats.filter((f) => f.name.endsWith('.md'));
        const fingerprint = files.map((f) => `${f.name}:${f.mtimeMs}:${f.size}`).join('\n');
        const cached = this.cache;
        if (cached && cached.fingerprint === fingerprint && !dirWrittenSince(ledger, MEMORY_DIR, cached.revision))
            return cached.entries;
        // 并行读取：记忆库上限几百条，串行 await 会让每次检索/写入前的全量 list 线性放大 I/O 等待。
        // 指纹没变且本进程没再写过的文件直接复用上次的解析结果。
        const parsed = await Promise.all(files.map(async (file) => {
            const path = `${MEMORY_DIR}/${file.name}`;
            const known = this.activeCache.get(file.name);
            if (known && known.mtimeMs === file.mtimeMs && known.size === file.size && !writtenSince(ledger, path, known.revision)) {
                return known.entry;
            }
            const text = await this.fs.readText(path);
            let entry = null;
            if (text !== null) {
                try {
                    entry = parseMemory(file.name, text);
                }
                catch {
                    entry = null; // 坏文件跳过
                }
            }
            this.activeCache.set(file.name, { mtimeMs: file.mtimeMs, size: file.size, revision, entry });
            return entry;
        }));
        const listed = new Set(files.map((file) => file.name));
        for (const name of this.activeCache.keys())
            if (!listed.has(name))
                this.activeCache.delete(name);
        const entries = parsed.filter((e) => e !== null);
        entries.sort((a, b) => a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        this.cache = { revision, fingerprint, entries };
        return entries;
    }
    /** 按 id 取单条（不含 archive/）；不存在或坏文件返回 null。 */
    async get(id) {
        return withWorkspaceLock(this.fs.root, () => this.getNow(id));
    }
    async getNow(id) {
        if (!isMemoryId(id))
            return null; // 形状不合法的 id 等同不存在，工具层给出 not-found 而非异常
        const text = await this.fs.readText(this.pathOf(id));
        if (text === null)
            return null;
        try {
            return parseMemory(`${id}.md`, text);
        }
        catch {
            return null;
        }
    }
    /** 写入新记忆；正文超过 200 字时返回值带 overLength: true（软提示，不拒绝）。 */
    async write(input) {
        const now = new Date().toISOString();
        // id = `m-<36 进制毫秒>-<随机 6 hex>`（对齐 worlddelta）：同毫秒只留 2 位 base36
        // 会碰撞静默覆盖（同轮连写两条记忆不罕见），随机段必须够宽。
        const id = `m-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
        const meta = {
            created: now,
            updated: now,
            sourceRange: input.sourceRange ?? '',
            tags: input.tags ?? [],
            keys: input.keys ?? [],
        };
        await this.fs.writeText(this.pathOf(id), serializeMemory(meta, input.body));
        return {
            id,
            file: `${id}.md`,
            ...meta,
            body: input.body,
            archived: false,
            overLength: input.body.length > MEMORY_BODY_SOFT_LIMIT,
        };
    }
    /** 更新正文与 tags/keys、刷新 updated；默认合并列表，replace 模式允许 UI 删除或清空列表项。 */
    async update(id, patch, options) {
        return withWorkspaceLock(this.fs.root, () => this.updateNow(id, patch, options));
    }
    async updateNow(id, patch, options) {
        const existing = await this.get(id);
        if (!existing)
            return null;
        const lists = options?.listMode ?? 'merge';
        const updateList = (current, next) => {
            if (next === undefined)
                return current;
            return [...new Set(lists === 'replace' ? next : [...current, ...next])];
        };
        const meta = {
            created: existing.created,
            updated: new Date().toISOString(),
            // 面板明确改写摘要后，它成为人工修订，不再被来源回滚自动展开。
            sourceRange: lists === 'replace' && isMemorySummary(existing.sourceRange) ? '' : existing.sourceRange,
            tags: updateList(existing.tags, patch.tags),
            keys: updateList(existing.keys, patch.keys),
        };
        const body = patch.body ?? existing.body;
        await this.fs.writeText(this.pathOf(id), serializeMemory(meta, body));
        return { ...existing, ...meta, body };
    }
    /** 事务删除（经 fs.delete）；不存在返回 false。 */
    async delete(id) {
        return withWorkspaceLock(this.fs.root, async () => {
            if (!isMemoryId(id) || (await this.fs.readText(this.pathOf(id))) === null)
                return false;
            await this.fs.delete(this.pathOf(id));
            return true;
        });
    }
    /** 移入 memory/archive/（读原文件 → 写 archive 路径 → 删原路径，全经 fs）；返回移动条数。 */
    async archive(ids) {
        return withWorkspaceLock(this.fs.root, () => this.archiveNow(ids));
    }
    async archiveNow(ids) {
        let moved = 0;
        for (const id of ids) {
            const text = await this.fs.readText(this.pathOf(id));
            if (text === null)
                continue;
            // 两步都经文件层登记：所有实例都会重读归档路径，不依赖 mtime 刻度区分同长度的两次写入。
            await this.fs.writeText(this.pathOf(id, true), text);
            await this.fs.delete(this.pathOf(id));
            moved++;
        }
        return moved;
    }
    /** 归并使用乐观校验：等待 LLM 时来源被编辑、删除或回滚，就放弃旧摘要。 */
    async mergeBatch(batch, body, kind) {
        return withWorkspaceLock(this.fs.root, async () => {
            for (const source of batch) {
                const current = await this.get(source.id);
                if (!current || serializeMemory(current, current.body) !== serializeMemory(source, source.body))
                    return 0;
            }
            if (!batch.length)
                return 0;
            await this.write({
                body,
                tags: [...new Set([kind === 'compress' ? 'compressed' : 'merged', ...batch.flatMap((entry) => entry.tags)])],
                keys: [...new Set(batch.flatMap((entry) => entry.keys))],
                sourceRange: memorySourceRange(kind, batch.map((entry) => entry.id)),
            });
            return this.archive(batch.map((entry) => entry.id));
        });
    }
    /**
     * 取与当前磁盘状态对齐的 BM25 索引；调用方必须持有工作区锁，并在返回后同步用完。
     * 活跃集与归档指纹都没变就直接复用；否则重新展开来源，再把索引增量对齐到新的条目集合。
     */
    async buildIndex(includeSources = false) {
        const entries = await this.list();
        const existing = includeSources ? this.sourceIndex : this.activeIndex;
        const revision = this.ledger.counter;
        // 别名只进检索索引：去重比较的是新正文与已有条目，别名会让同一段正文显得不那么相似。
        let records = NO_ALIASES;
        const reusable = existing !== null && existing.synced === entries;
        if (!includeSources) {
            if (reusable)
                return existing;
        }
        else if (reusable && !dirWrittenSince(this.ledger, ARCHIVE_DIR, existing.revision)) {
            // 缓存命中的常见路径：归档来源与别名文件的指纹一次批量取回，不为别名多发一轮 stat。
            const stats = await this.fs.statMany([...existing.sourceFiles, ALIAS_PATH]);
            records = await this.loadAliases(stats[existing.sourceFiles.length] ?? null);
            const fingerprint = sourceFingerprintOf(existing.sourceFiles.map((path, index) => [path, stats[index] ?? null]));
            if (existing.aliasRecords === records && existing.sourceFingerprint === fingerprint)
                return existing;
        }
        else {
            records = await this.loadAliases();
        }
        const indexed = [...entries];
        const sources = [];
        if (includeSources) {
            const visited = new Set(entries.map((entry) => memoryIdentity(entry.id)));
            // 只索引活跃摘要可达的归档来源；不扫整棵 archive，已撤销/删除摘要不会把旧事实带回来。
            // 按层展开：同一层的来源并行加载，层内与层间的先后仍是原来的队列顺序。
            let frontier = entries;
            while (frontier.length > 0) {
                const ids = [];
                // 展开中途遇到的故障要排在「更早来源的读取故障」之后报告，先记下再加载已收集的部分。
                let deferred;
                let stopped = false;
                for (const entry of frontier) {
                    try {
                        for (const id of memorySourceIds(entry.sourceRange)) {
                            const identity = memoryIdentity(id);
                            if (visited.has(identity))
                                continue;
                            if (visited.size >= 10_000)
                                throw new Error('记忆来源索引超过 10000 条，请分拆剧情或清理记忆');
                            visited.add(identity);
                            ids.push(id);
                        }
                    }
                    catch (error) {
                        deferred = error;
                        stopped = true;
                        break;
                    }
                }
                const loaded = await this.loadSources(ids, revision);
                if (stopped)
                    throw deferred;
                const next = [];
                for (const source of loaded) {
                    sources.push(source);
                    indexed.push(source.entry);
                    next.push(source.entry);
                }
                frontier = next;
            }
            // 不再可达的来源不留在缓存里；失败的重建在上面抛出，不会走到这里误删。
            const reachable = new Set(sources.map((source) => source.path));
            for (const path of this.sourceCache.keys())
                if (!reachable.has(path))
                    this.sourceCache.delete(path);
        }
        // 来源全部加载成功后才动索引：中途失败时上一份索引保持原样。以下到返回之间没有 await。
        const index = existing?.index ?? new Bm25Index();
        const previous = existing?.entries ?? new Map();
        const next = new Map(indexed.map((entry) => [memoryIdentity(entry.id), entry]));
        const previousAliases = existing?.aliases ?? new Map();
        const aliases = new Map();
        if (records.size > 0) {
            for (const [identity, entry] of next) {
                const list = this.aliasesOf(entry, records);
                if (list)
                    aliases.set(identity, list);
            }
        }
        // 未变的活跃条目和归档来源都来自解析缓存，是同一个对象；对象换了就是正文或元数据变了。别名变了同样要重新入索引。
        const unchanged = (identity, entry) => previous.get(identity) === entry && next.get(identity) === entry && sameList(previousAliases.get(identity), aliases.get(identity));
        for (const [identity, entry] of previous)
            if (!unchanged(identity, entry))
                index.remove(entry.id);
        for (const [identity, entry] of next) {
            if (unchanged(identity, entry))
                continue;
            index.add({
                id: entry.id,
                text: entry.body,
                keys: entry.keys,
                aliases: aliases.get(identity),
                ts: Date.parse(entry.updated),
                data: entry,
            });
        }
        // 指纹取自读取前的 stat：读到的正文只会比指纹新，下次核对不符就重读，不会把旧正文钉在新指纹下。
        // synced 记下这次用的活跃快照：等待期间若别的任务让 list 换了一份，下次调用会再对齐一遍。
        const built = { index, entries: next, aliases, aliasRecords: records, synced: entries, revision,
            sourceFiles: sources.map((source) => source.path),
            sourceFingerprint: sourceFingerprintOf(sources.map((source) => [source.path, source.stat])) };
        if (includeSources)
            this.sourceIndex = built;
        else
            this.activeIndex = built;
        return built;
    }
    /**
     * 按给定顺序加载一批归档来源：磁盘指纹与缓存一致就复用已解析条目，否则读盘解析并写回缓存。
     * 先整批取指纹再读；来源是否存在仍以读取结果为准。缺失、解析失败和读取故障都不进缓存。
     * 取指纹阶段的故障先于读取阶段报告；同一阶段多个来源出错时报告顺序最靠前的那个。
     */
    async loadSources(ids, revision) {
        if (ids.length === 0)
            return [];
        const paths = ids.map((id) => this.pathOf(id, true));
        const stats = await this.fs.statMany(paths);
        const settled = await settleLimited(ids, SOURCE_READ_CONCURRENCY, async (id, index) => {
            const path = paths[index];
            const stat = stats[index] ?? null;
            const cached = this.sourceCache.get(path);
            if (stat && cached?.stat && cached.stat.mtimeMs === stat.mtimeMs && cached.stat.size === stat.size
                && !writtenSince(this.ledger, path, cached.revision))
                return cached;
            this.sourceCache.delete(path);
            const raw = await this.fs.readText(path);
            if (raw === null)
                throw new Error(`摘要来源 ${id} 缺失，无法保证检索完整性`);
            const loaded = { path, stat, revision, entry: parseMemory(`${ARCHIVE_PREFIX}${id}.md`, raw) };
            // 没有指纹就无从校验，下次照常重读。
            if (stat)
                this.sourceCache.set(path, loaded);
            return loaded;
        });
        const loaded = [];
        for (const result of settled) {
            // 留空的是出错后未领取的任务，必然排在已记录的失败之后，轮不到它们。
            if (result === undefined)
                break;
            if (result.status === 'rejected')
                throw result.reason;
            loaded.push(result.value);
        }
        return loaded;
    }
    /**
     * 写入前去重检索：query = text + keys，按 IDF 加权的双向覆盖率打分（0–1），不做时间衰减。
     * 分数不随库规模和正文长度漂移，可直接与固定阈值比较；工具层据此提示 agent 改用 update 合并，
     * 而不是重复 write。
     */
    async findSimilar(text, keys, topK) {
        // 索引跨调用保留并原地更新，对齐与查询必须在同一把锁内完成。
        return withWorkspaceLock(this.fs.root, async () => {
            const { index } = await this.buildIndex();
            return index
                .similarity([text, ...keys].join(' '), { topK: topK ?? this.similarTopK })
                .map((hit) => ({ entry: hit.data, score: hit.score }));
        });
    }
    /**
     * 检索：BM25 + 时间衰减。仅自动入模额外请求摘要来源并给最新输入加权（boost），
     * 工具不传这两项，结果形状不变。
     */
    async search(query, options) {
        return withWorkspaceLock(this.fs.root, async () => {
            const { index, entries } = await this.buildIndex(true);
            return index.search(query, options).map((hit) => ({ entry: hit.data, score: hit.score,
                ...(options?.includeSummarySources && isMemorySummary(hit.data.sourceRange)
                    ? { summarySourceIds: summarySourceIds(hit.id, entries) } : {}),
            }));
        });
    }
    /** 容量统计：条数与正文 token 粗估累加。 */
    async stats() {
        const entries = await this.list();
        return {
            count: entries.length,
            tokens: entries.reduce((sum, entry) => sum + estimateTokens(entry.body), 0),
        };
    }
    /** 最旧的 n 条（created 升序），压缩取批次用。 */
    async oldest(n) {
        return (await this.list()).slice(0, Math.max(0, n));
    }
}
