/** 模板 JSON 的无损分块存储：内容寻址复用历史，所有新块先记 WAL，最后原子发布根引用。 */
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { WorkspaceSizeError } from './workspaceFs.js';
import { ledgerKey, openLedger } from './writeLedger.js';
export const TEMPLATE_DATA_PATH = 'state/template-data';
export const TEMPLATE_DOCUMENT_LIMIT = 64 * 1024 * 1024;
const DOCUMENT_LIMIT_MESSAGE = '模板状态展开后超过 64 MiB 上限；请从较早楼层创建分支，或恢复完整剧情备份';
const BLOCK_LIMIT = 4 * 1024 * 1024;
/** 不超过该字节数的状态整份留在根文件里，不分块。 */
export const TEMPLATE_INLINE_LIMIT = 64 * 1024;
const LEAF_LIMIT = 2048;
const PAGE_SIZE = 32;
/** 单个文档可引用的不同数据块数。 */
const BLOCK_COUNT_LIMIT = 131072;
/** 展开一个文档所访问的引用数；写入按读取的同一口径计数，能写入的文档一定能读回。 */
const VISIT_LIMIT = 2 * 1024 * 1024;
/** JSON 的逻辑嵌套预算与存储索引分开；宽数组的分页不能消耗调用方的嵌套额度。 */
const DOCUMENT_DEPTH_LIMIT = 64;
/** 每层最多由访问预算产生这些分页索引；即使每层都分页，合法文档仍能冷读。 */
const REFERENCE_DEPTH_LIMIT = (DOCUMENT_DEPTH_LIMIT + 1) * (Math.ceil(Math.log(VISIT_LIMIT) / Math.log(PAGE_SIZE)) + 1);
/** 同时保留核对结论的剧情数；超出后最久未用的剧情下次读取时重新核对磁盘。 */
const CACHED_STORIES = 8;
/** 各剧情解析结果合计保留的字符数；超出后从最久未用的剧情开始丢弃，下次读取重新展开。 */
const PARSED_BUDGET = 64 * 1024 * 1024;
const digest = (raw) => createHash('sha256').update(raw).digest('hex');
const validHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const blockPath = (hash) => `${TEMPLATE_DATA_PATH}/${hash.slice(0, 2)}/${hash}.json`;
/** 约每 16 个键出现一次的稳定边界；只取决于键的内容，与它在对象里的位置无关。 */
function pageBreak(key) {
    let hash = 2166136261;
    for (let i = 0; i < key.length; i++)
        hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
    return (hash & 15) === 0;
}
const stories = new Map();
const storyKey = (root) => { const absolute = resolve(root); return process.platform === 'win32' ? absolute.toLowerCase() : absolute; };
const DATA_KEY = ledgerKey(TEMPLATE_DATA_PATH);
function storyBlocks(fs) {
    const key = storyKey(fs.root), ledger = openLedger(fs.root);
    let cache = stories.get(key);
    if (cache)
        stories.delete(key);
    else
        cache = { known: new Set(), revision: ledger.counter, epoch: ledger.epoch, root: null };
    stories.set(key, cache);
    if (stories.size > CACHED_STORIES)
        stories.delete(stories.keys().next().value);
    // 本模块之外写过或删过块目录（人工维护、回滚）就全部重新核对；自己的写入在完成后推进序号。
    let foreign = ledger.epoch !== cache.epoch;
    for (const [dir, order] of ledger.dirs)
        foreign ||= order > cache.revision && (dir === DATA_KEY || dir.startsWith(DATA_KEY + '/'));
    if (foreign) {
        cache.known.clear();
        cache.parsed = undefined;
        cache.selected = undefined;
        cache.root = null;
        cache.epoch = ledger.epoch;
        cache.revision = ledger.counter;
    }
    return cache;
}
/** 全部预算和结构先在内存检查，拒绝时尚未开始任何正文或 WAL 写入。 */
export function prepareTemplateDocument(value) {
    const raw = JSON.stringify(value), bytes = Buffer.byteLength(raw);
    if (bytes > TEMPLATE_DOCUMENT_LIMIT)
        throw new Error(DOCUMENT_LIMIT_MESSAGE);
    const blocks = new Map();
    // 与读取时每个引用访问一次的口径一致：重复引用同一块也逐次计数。
    let visits = 0;
    const visit = () => { if (++visits > VISIT_LIMIT)
        throw new Error('模板状态数据块展开超过上限'); };
    const store = (block) => {
        const text = JSON.stringify(block);
        if (Buffer.byteLength(text) > BLOCK_LIMIT)
            throw new Error('模板状态数据块超过 4 MiB 上限');
        const hash = digest(text);
        blocks.set(hash, text);
        if (blocks.size > BLOCK_COUNT_LIMIT)
            throw new Error('模板状态数据块数量超过上限');
        visit();
        // 读取 json 块时还要再展开一次其中的叶子。
        if (block[0] === 'json')
            visit();
        return { ref: hash };
    };
    const pages = (kind, refs) => {
        if (refs.length <= PAGE_SIZE)
            return store([kind, refs]);
        const next = [];
        for (let i = 0; i < refs.length; i += PAGE_SIZE)
            next.push(store([kind, refs.slice(i, i + PAGE_SIZE)]));
        return pages(kind, next);
    };
    const encode = (item, depth = 0) => {
        if (depth > DOCUMENT_DEPTH_LIMIT)
            throw new Error('模板状态嵌套超过上限');
        const text = JSON.stringify(item);
        if (Buffer.byteLength(text) <= LEAF_LIMIT) {
            visit();
            return { json: text };
        }
        if (item === null || typeof item !== 'object')
            return store(['json', text]);
        if (Array.isArray(item)) {
            const refs = item.map(child => encode(child, depth + 1));
            if (refs.length <= PAGE_SIZE)
                return store(['array', refs]);
            const groups = [];
            for (let i = 0; i < refs.length; i += PAGE_SIZE)
                groups.push(store(['array', refs.slice(i, i + PAGE_SIZE)]));
            return pages('array-pages', groups);
        }
        const entries = Object.entries(item).map(([key, child]) => [key, encode(child, depth + 1)]);
        if (entries.length <= PAGE_SIZE)
            return store(['object', entries]);
        // 分页边界由键本身决定：按消息身份排序的表会在任意位置插入新键，
        // 按位置每 32 项切分会让插入点之后的每一页都错位重写。读取端只要求每页不超过上限。
        const groups = [];
        let group = [];
        for (const entry of entries) {
            if (group.length >= PAGE_SIZE || group.length && pageBreak(entry[0])) {
                groups.push(store(['object', group]));
                group = [];
            }
            group.push(entry);
        }
        groups.push(store(['object', group]));
        return pages('object-pages', groups);
    };
    // 即使旧文件仍以内联格式写入，也检查单个不可拆分值，避免绕过新块预算。
    const root = encode(JSON.parse(raw));
    if (bytes <= TEMPLATE_INLINE_LIMIT)
        return { raw, json: raw, blocks: new Map() };
    const hash = 'ref' in root ? root.ref : store(['json', root.json]).ref;
    return { raw: JSON.stringify({ version: 2, storage: 'tavern-template', root: hash, bytes }), json: raw, blocks };
}
/** 批量读取数据块原文；超限文件不读入内存。 */
async function readBlocks(fs, hashes) {
    try {
        return await fs.readTextMany(hashes.map(blockPath), BLOCK_LIMIT);
    }
    catch (error) {
        if (error instanceof WorkspaceSizeError)
            throw new Error('模板状态数据块超过 4 MiB 上限');
        throw error;
    }
}
/**
 * 重复块不重写；已存在但字节不符属于损坏，不能通过覆盖把损坏隐藏起来。
 * current 是调用方刚读到的根文件原文：只有它仍是本进程最后同步的那一份，才沿用内存里「块已在磁盘」的结论。
 */
export async function writeTemplateBlocks(fs, document, current) {
    const cache = storyBlocks(fs);
    if (cache.root !== current) {
        cache.known.clear();
        cache.parsed = undefined;
        cache.root = current;
    }
    // 整个块目录被移走时不凭内存结论跳过写入。
    if (cache.known.size && !(await fs.stat(TEMPLATE_DATA_PATH)))
        cache.known.clear();
    const pending = [...document.blocks].filter(([hash]) => !cache.known.has(hash));
    const existing = await readBlocks(fs, pending.map(([hash]) => hash));
    const missing = [];
    pending.forEach(([hash, raw], index) => {
        const previous = existing[index];
        if (previous === null)
            missing.push([blockPath(hash), raw]);
        else if (previous !== raw)
            throw new Error(`模板状态数据块校验失败：${hash}`);
    });
    // 新块一次记入 WAL 再落盘；自己的写入不算外部改动。
    try {
        await fs.writeTextMany(missing);
    }
    finally {
        cache.revision = openLedger(fs.root).counter;
    }
}
/** 内部视图只读；选择器也不能把共享缓存改成下次读取可见的状态。 */
function freezeJson(value) {
    if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value))
            freezeJson(child);
        Object.freeze(value);
    }
    return value;
}
function rememberParsed(cache, path, raw, parsed) {
    const json = JSON.stringify(parsed);
    cache.parsed = { path, raw, value: freezeJson(JSON.parse(json)), size: json.length };
    trimParsed(cache);
}
/** 完整视图、路径结果与键页共用进程内存预算，淘汰只影响下一次读取的速度。 */
function trimParsed(cache) {
    let total = 0;
    for (const story of stories.values())
        total += (story.parsed?.size ?? 0) + (story.selected?.size ?? 0);
    for (const story of stories.values()) {
        if (total <= PARSED_BUDGET)
            break;
        if (story === cache)
            continue;
        total -= (story.parsed?.size ?? 0) + (story.selected?.size ?? 0);
        story.parsed = undefined;
        story.selected = undefined;
    }
    if (cache.selected)
        for (const [key, entry] of cache.selected.values) {
            if (total <= PARSED_BUDGET)
                break;
            total -= entry.size;
            cache.selected.size -= entry.size;
            cache.selected.values.delete(key);
        }
    if (cache.selected)
        for (const [key, entry] of cache.selected.blocks) {
            if (total <= PARSED_BUDGET)
                break;
            total -= entry.size;
            cache.selected.size -= entry.size;
            cache.selected.blocks.delete(key);
        }
    if (cache.selected)
        for (const [key, entry] of cache.selected.parsers) {
            if (total <= PARSED_BUDGET)
                break;
            total -= entry.size;
            cache.selected.size -= entry.size;
            cache.selected.parsers.delete(key);
        }
}
/**
 * 根引用已原子发布：文档的全部块此刻都在磁盘且内容已知，后续保存不必再向磁盘确认未变的块。
 * parsed 是调用方对同一份文档的解析结果（与读取时 parse 的返回值相同），之后的读取直接返回它的副本。
 */
export function adoptTemplateDocument(fs, path, document, parsed) {
    const cache = storyBlocks(fs);
    cache.known = new Set(document.blocks.keys());
    cache.root = document.raw;
    cache.parsed = undefined;
    cache.selected = undefined;
    // 内联文档每次读取本来就只读一个小文件，不占用解析结果的预算。
    if (document.blocks.size && parsed !== undefined)
        rememberParsed(cache, path, document.raw, parsed);
    cache.revision = openLedger(fs.root).counter;
}
/** 逐层批量取回根可达的全部块，核对体积与摘要后返回。 */
async function fetchBlocks(fs, root) {
    const blocks = new Map();
    const reachable = new Set([root]);
    let frontier = [root];
    for (let depth = 0; frontier.length; depth++) {
        if (depth > REFERENCE_DEPTH_LIMIT)
            throw new Error('模板状态数据块展开超过上限');
        const texts = await readBlocks(fs, frontier);
        const next = [];
        frontier.forEach((hash, index) => {
            const text = texts[index];
            if (text === null)
                throw new Error(`模板状态数据块缺失：${hash}`);
            if (Buffer.byteLength(text) > BLOCK_LIMIT || digest(text) !== hash)
                throw new Error(`模板状态数据块校验失败：${hash}`);
            const block = JSON.parse(text);
            blocks.set(hash, block);
            if (!Array.isArray(block) || block.length !== 2 || block[0] === 'json' || !Array.isArray(block[1]))
                return;
            for (const item of block[1]) {
                const child = block[0] === 'object' && Array.isArray(item) ? item[1] : item;
                if (!object(child) || !validHash(child.ref) || reachable.has(child.ref))
                    continue;
                reachable.add(child.ref);
                if (reachable.size > BLOCK_COUNT_LIMIT)
                    throw new Error('模板状态数据块数量超过上限');
                next.push(child.ref);
            }
        });
        frontier = next;
    }
    return blocks;
}
/** 只展开根可达块；校验节点、展开字节与深度，不把引用当作文件路径或执行代码。 */
function decodeReference(root, blocks, logicalDepth = 0, physicalDepth = 0) {
    const active = new Set();
    let visited = 0, leafBytes = 0;
    const checked = (value, bytes) => {
        if (bytes > TEMPLATE_DOCUMENT_LIMIT)
            throw new Error(DOCUMENT_LIMIT_MESSAGE);
        return { value, bytes };
    };
    const decode = (ref, depth = 0, referenceDepth = 0) => {
        if (++visited > VISIT_LIMIT || depth > DOCUMENT_DEPTH_LIMIT || referenceDepth > REFERENCE_DEPTH_LIMIT)
            throw new Error('模板状态数据块展开超过上限');
        if (!object(ref) || Object.keys(ref).length !== 1)
            throw new Error('模板状态数据块引用损坏');
        if (typeof ref.json === 'string') {
            const bytes = Buffer.byteLength(ref.json);
            if (bytes > BLOCK_LIMIT)
                throw new Error('模板状态数据块超过 4 MiB 上限');
            // 引用复用可形成高倍展开；必须在下一次分配之前累计，而非只检查最终根大小。
            leafBytes += bytes;
            if (leafBytes > TEMPLATE_DOCUMENT_LIMIT)
                throw new Error(DOCUMENT_LIMIT_MESSAGE);
            return checked(JSON.parse(ref.json), bytes);
        }
        if (!validHash(ref.ref) || active.has(ref.ref))
            throw new Error('模板状态数据块引用损坏或循环');
        const hash = ref.ref, block = blocks.get(hash);
        if (block === undefined)
            throw new Error(`模板状态数据块缺失：${hash}`);
        if (!Array.isArray(block) || block.length !== 2)
            throw new Error('模板状态数据块结构损坏');
        const [kind, data] = block;
        active.add(hash);
        try {
            if (kind === 'json')
                return decode({ json: data }, depth, referenceDepth + 1);
            if (typeof kind !== 'string' || !['array', 'object', 'array-pages', 'object-pages'].includes(kind) || !Array.isArray(data) || data.length > PAGE_SIZE)
                throw new Error('模板状态数据块结构损坏');
            const items = [], entries = [], keys = new Set();
            let bytes = 2, count = 0;
            const append = (key, child) => {
                bytes += child.bytes + (count++ > 0 ? 1 : 0) + (key === undefined ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1);
                checked(null, bytes);
                if (key === undefined)
                    items.push(child.value);
                else {
                    if (keys.has(key))
                        throw new Error('模板状态数据块键重复');
                    keys.add(key);
                    entries.push([key, child.value]);
                }
            };
            for (const item of data) {
                if (kind === 'array')
                    append(undefined, decode(item, depth + 1, referenceDepth + 1));
                else if (kind === 'object') {
                    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string')
                        throw new Error('模板状态数据块键损坏');
                    append(item[0], decode(item[1], depth + 1, referenceDepth + 1));
                }
                else {
                    const page = decode(item, depth, referenceDepth + 1);
                    if (kind === 'array-pages') {
                        if (!Array.isArray(page.value))
                            throw new Error('模板状态数组分页损坏');
                        for (const value of page.value)
                            append(undefined, { value, bytes: Buffer.byteLength(JSON.stringify(value)) });
                    }
                    else {
                        if (!object(page.value))
                            throw new Error('模板状态对象分页损坏');
                        for (const [key, value] of Object.entries(page.value))
                            append(key, { value: value, bytes: Buffer.byteLength(JSON.stringify(value)) });
                    }
                }
            }
            return checked(kind.startsWith('array') ? items : Object.fromEntries(entries), bytes);
        }
        finally {
            active.delete(hash);
        }
    };
    return decode(root, logicalDepth, physicalDepth);
}
function decodeDocument(document, blocks) {
    const decoded = decodeReference({ ref: document.root }, blocks);
    if (decoded.bytes !== document.bytes)
        throw new Error('模板状态展开字节数不一致');
    return decoded.value;
}
async function readRoot(fs, path) {
    const metadata = await fs.stat(path);
    if (metadata && metadata.size > TEMPLATE_DOCUMENT_LIMIT)
        throw new Error(DOCUMENT_LIMIT_MESSAGE);
    const raw = await fs.readText(path);
    if (raw !== null && Buffer.byteLength(raw) > TEMPLATE_DOCUMENT_LIMIT)
        throw new Error(DOCUMENT_LIMIT_MESSAGE);
    return raw;
}
function parseDocumentRoot(document) {
    if (document.storage !== 'tavern-template' || !validHash(document.root)
        || Object.keys(document).some(key => !['version', 'storage', 'root', 'bytes'].includes(key))
        || !Number.isSafeInteger(document.bytes) || document.bytes < 0 || document.bytes > TEMPLATE_DOCUMENT_LIMIT)
        throw new Error('模板状态根引用损坏');
    return document;
}
async function decodeRoot(fs, raw, references, remember = true) {
    if (raw === null)
        return { value: null };
    const document = JSON.parse(raw);
    if (!object(document) || document.version !== 2) {
        // 旧版及本地抬高限制后留下的完整 JSON 可无损迁移；异常大单值仍明确拒绝。
        if (Buffer.byteLength(raw) > BLOCK_LIMIT)
            prepareTemplateDocument(document);
        return { value: document };
    }
    const manifest = parseDocumentRoot(document);
    const cache = remember ? storyBlocks(fs) : undefined;
    const blocks = await fetchBlocks(fs, manifest.root);
    const value = decodeDocument(manifest, blocks);
    // 当前根可达的块刚从磁盘逐一核对过。
    if (cache) {
        cache.known = new Set(blocks.keys());
        if (cache.root !== raw) {
            cache.root = raw;
            cache.parsed = undefined;
        }
    }
    if (references)
        for (const hash of blocks.keys())
            references.add(blockPath(hash));
    return { value, cache };
}
/** 读取文档并返回展开后的 JSON；references 收集根可达块的路径。 */
export async function readTemplateDocument(fs, path, references) {
    return (await decodeRoot(fs, await readRoot(fs, path), references)).value;
}
/** 展开 WAL 等位置保存的历史根原文，不替换磁盘根，也不改变当前根的缓存结论。 */
export async function readTemplateDocumentText(fs, raw, references) {
    if (raw !== null && Buffer.byteLength(raw) > TEMPLATE_DOCUMENT_LIMIT)
        throw new Error(DOCUMENT_LIMIT_MESSAGE);
    return (await decodeRoot(fs, raw, references, false)).value;
}
/** 路径只访问自有 JSON 属性；数组下标不能借原型链读到方法或其它进程对象。 */
function selectJsonPath(value, path, offset = 0) {
    for (let i = offset; i < path.length; i++) {
        const key = path[i];
        if (Array.isArray(value)) {
            if (typeof key !== 'number')
                throw new Error('模板状态选择路径经过错误的容器类型');
            if (!Number.isSafeInteger(key) || key < 0 || key >= value.length)
                return undefined;
            value = value[key];
        }
        else if (object(value) && typeof key === 'string') {
            if (!Object.hasOwn(value, key))
                return undefined;
            value = value[key];
        }
        else
            throw new Error('模板状态选择路径经过错误的容器类型');
    }
    return value;
}
/**
 * 冷读少数字段或指定消息，不先展开无关回复、变量历史或生成正文。返回顺序与 paths 一致，
 * 缺字段为 undefined，根文件不存在为 null；空路径选择整份文档并核对完整展开字节数。
 * 每个实际访问的块都核对摘要与结构，对象分页仍扫描键页，因为旧格式没有按键路由索引。
 * 此读取不产生「整图已验证」或完整解析缓存结论；写入、回滚与完整读取继续核对完整图。
 */
export async function readTemplateDocumentPaths(fs, path, paths) {
    if (paths.length > VISIT_LIMIT || paths.some(item => item.length > DOCUMENT_DEPTH_LIMIT
        || item.some(key => typeof key !== 'string' && (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0))))
        throw new Error('模板状态选择路径损坏或超过上限');
    const raw = await readRoot(fs, path);
    if (raw === null)
        return null;
    const parsed = JSON.parse(raw);
    if (!object(parsed) || parsed.version !== 2) {
        if (Buffer.byteLength(raw) > BLOCK_LIMIT)
            prepareTemplateDocument(parsed);
        return paths.map(item => structuredClone(selectJsonPath(parsed, item)));
    }
    const document = parseDocumentRoot(parsed), blocks = new Map();
    const cache = storyBlocks(fs);
    if (cache.selected && (cache.selected.path !== path || cache.selected.raw !== raw
        || !(await fs.stat(TEMPLATE_DATA_PATH))))
        cache.selected = undefined;
    cache.selected ??= { path, raw, values: new Map(), parsers: new Map(), blocks: new Map(), size: 0 };
    const selections = cache.selected;
    const pending = new Map();
    const promised = new Map();
    let scheduled = false, visits = 0, selectedBytes = 0, loadedMinimum = 0;
    const visit = (depth) => {
        if (++visits > VISIT_LIMIT || depth > REFERENCE_DEPTH_LIMIT)
            throw new Error('模板状态数据块展开超过上限');
    };
    const checkedRef = (value) => {
        if (!object(value) || Object.keys(value).length !== 1)
            throw new Error('模板状态数据块引用损坏');
        if (typeof value.json === 'string') {
            if (Buffer.byteLength(value.json) > BLOCK_LIMIT)
                throw new Error('模板状态数据块超过 4 MiB 上限');
            return { json: value.json };
        }
        if (!validHash(value.ref))
            throw new Error('模板状态数据块引用损坏');
        return { ref: value.ref };
    };
    // 同一层的并行需求汇成一次批量读取；WorkspaceFs 自己限制磁盘并发，不为每个引用开一个文件任务。
    const getBlock = (hash) => {
        const previous = promised.get(hash);
        if (previous)
            return previous;
        if (promised.size >= BLOCK_COUNT_LIMIT)
            return Promise.reject(new Error('模板状态数据块数量超过上限'));
        const remembered = selections.blocks.get(hash);
        if (remembered) {
            // 连续展示不同消息会复用同一批键页；预算仍按本次访问累计，缓存命中不能放宽坏根检查。
            accountLoadedBlock(remembered.value);
            selections.blocks.delete(hash);
            selections.blocks.set(hash, remembered);
            blocks.set(hash, remembered.value);
            const promise = Promise.resolve(remembered.value);
            promised.set(hash, promise);
            return promise;
        }
        const promise = new Promise((resolve, reject) => pending.set(hash, { resolve, reject }));
        promised.set(hash, promise);
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => {
                scheduled = false;
                const batch = [...pending];
                pending.clear();
                void readBlocks(fs, batch.map(([key]) => key)).then(texts => {
                    for (let i = 0; i < batch.length; i++) {
                        const [key, waiter] = batch[i], text = texts[i];
                        try {
                            if (text === null)
                                throw new Error(`模板状态数据块缺失：${key}`);
                            if (Buffer.byteLength(text) > BLOCK_LIMIT || digest(text) !== key)
                                throw new Error(`模板状态数据块校验失败：${key}`);
                            const block = JSON.parse(text);
                            accountLoadedBlock(block);
                            if (Array.isArray(block) && block[0] !== 'json') {
                                const size = Buffer.byteLength(text) + 128;
                                selections.blocks.set(key, { value: freezeJson(block), size });
                                selections.size += size;
                                trimParsed(cache);
                            }
                            blocks.set(key, block);
                            waiter.resolve(block);
                        }
                        catch (error) {
                            waiter.reject(error);
                        }
                    }
                }, error => { for (const [, waiter] of batch)
                    waiter.reject(error); });
            });
        }
        return promise;
    };
    const contents = (block) => {
        if (!Array.isArray(block) || block.length !== 2 || typeof block[0] !== 'string')
            throw new Error('模板状态数据块结构损坏');
        if (block[0] === 'json') {
            if (typeof block[1] !== 'string' || Buffer.byteLength(block[1]) > BLOCK_LIMIT)
                throw new Error('模板状态数据块结构损坏');
            return { kind: 'json', data: block[1] };
        }
        if (!['array', 'object', 'array-pages', 'object-pages'].includes(block[0]) || !Array.isArray(block[1]) || block[1].length > PAGE_SIZE)
            throw new Error('模板状态数据块结构损坏');
        return { kind: block[0], data: block[1] };
    };
    const entries = (data) => {
        const seen = new Set();
        return data.map(item => {
            if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string')
                throw new Error('模板状态数据块键损坏');
            if (seen.has(item[0]))
                throw new Error('模板状态数据块键重复');
            seen.add(item[0]);
            return [item[0], checkedRef(item[1])];
        });
    };
    /**
     * 已读的不同块至少要占用这些展开字节。页括号可能被合并，叶子统一减去两个括号字节，
     * 只作保守下界；仍能在积累大量恶意大键页之前拒绝，不等选完一个很小字段才核对。
     */
    const accountLoadedBlock = (block) => {
        const { kind, data } = contents(block);
        if (typeof data === 'string')
            loadedMinimum += Math.max(0, Buffer.byteLength(data) - 2);
        else {
            const refs = kind === 'object' ? entries(data).map(([key, value]) => {
                loadedMinimum += Buffer.byteLength(JSON.stringify(key)) + 1;
                return value;
            }) : data.map(checkedRef);
            if (kind === 'array' || kind === 'object')
                loadedMinimum += Math.max(0, data.length - 1);
            for (const ref of refs)
                if ('json' in ref)
                    loadedMinimum += Math.max(0, Buffer.byteLength(ref.json) - 2);
        }
        if (loadedMinimum > document.bytes)
            throw new Error('模板状态展开字节数不一致');
    };
    const indexes = new Map();
    const index = async (ref, depth = 0, active = new Set()) => {
        visit(depth);
        if ('json' in ref)
            return { kind: 'json', value: JSON.parse(ref.json), depth: 0 };
        if (active.has(ref.ref))
            throw new Error('模板状态数据块引用损坏或循环');
        const key = `${ref.ref}:${depth}`, previous = indexes.get(key);
        if (previous)
            return previous;
        const next = new Set(active);
        next.add(ref.ref);
        const result = (async () => {
            const { kind, data } = contents(await getBlock(ref.ref));
            if (typeof data === 'string') {
                visit(depth + 1);
                return { kind: 'json', value: JSON.parse(data), depth: 1 };
            }
            if (kind === 'array')
                return { kind: 'array', refs: data.map(item => ({ value: checkedRef(item), depth: 1 })) };
            if (kind === 'object')
                return { kind: 'object', refs: new Map(entries(data).map(([name, value]) => [name, { value, depth: 1 }])) };
            const pages = await Promise.all(data.map(item => index(checkedRef(item), depth + 1, next)));
            if (kind === 'array-pages') {
                const refs = [];
                for (const page of pages) {
                    if (page.kind === 'array') {
                        for (const child of page.refs)
                            refs.push({ value: child.value, depth: child.depth + 1 });
                    }
                    else if (page.kind === 'json' && Array.isArray(page.value)) {
                        for (const value of page.value)
                            refs.push({ value: { json: JSON.stringify(value) }, depth: page.depth + 1 });
                    }
                    else
                        throw new Error('模板状态数组分页损坏');
                    if (refs.length > VISIT_LIMIT)
                        throw new Error('模板状态数据块展开超过上限');
                }
                return { kind: 'array', refs };
            }
            const refs = new Map();
            for (const page of pages) {
                const values = page.kind === 'object' ? page.refs : page.kind === 'json' && object(page.value)
                    ? Object.entries(page.value).map(([name, value]) => [name, { value: { json: JSON.stringify(value) }, depth: page.depth }]) : undefined;
                if (!values)
                    throw new Error('模板状态对象分页损坏');
                for (const [name, child] of values) {
                    if (refs.has(name))
                        throw new Error('模板状态数据块键重复');
                    refs.set(name, { value: child.value, depth: child.depth + 1 });
                    if (refs.size > VISIT_LIMIT)
                        throw new Error('模板状态数据块展开超过上限');
                }
            }
            return { kind: 'object', refs };
        })();
        indexes.set(key, result);
        return result;
    };
    const expanded = new Map();
    const expand = async (ref, depth = 0, active = new Set()) => {
        visit(depth);
        if ('json' in ref)
            return;
        if (active.has(ref.ref))
            throw new Error('模板状态数据块引用损坏或循环');
        const previous = expanded.get(ref.ref);
        if (previous)
            return previous;
        const next = new Set(active);
        next.add(ref.ref);
        const result = (async () => {
            const { kind, data } = contents(await getBlock(ref.ref));
            if (typeof data === 'string')
                return;
            const refs = kind === 'object' ? entries(data).map(([, child]) => child) : data.map(checkedRef);
            await Promise.all(refs.filter(child => 'ref' in child).map(child => expand(child, depth + 1, next)));
        })();
        expanded.set(ref.ref, result);
        return result;
    };
    const select = async (ref, keys, offset = 0, referenceDepth = 0) => {
        if (offset === keys.length) {
            await expand(ref, referenceDepth);
            const result = decodeReference(ref, blocks, offset, referenceDepth);
            if (result.bytes > document.bytes || offset === 0 && result.bytes !== document.bytes)
                throw new Error('模板状态展开字节数不一致');
            return result.value;
        }
        const selected = await index(ref, referenceDepth), key = keys[offset];
        if (selected.kind === 'json')
            return structuredClone(selectJsonPath(selected.value, keys, offset));
        if (selected.kind === 'object' && typeof key !== 'string' || selected.kind === 'array' && typeof key !== 'number')
            throw new Error('模板状态选择路径经过错误的容器类型');
        const child = selected.kind === 'object' && typeof key === 'string' ? selected.refs.get(key)
            : selected.kind === 'array' && typeof key === 'number' ? selected.refs[key] : undefined;
        return child ? select(child.value, keys, offset + 1, referenceDepth + child.depth) : undefined;
    };
    const results = [];
    for (const keys of paths) {
        const key = JSON.stringify(keys), remembered = selections.values.get(key);
        const value = remembered ? structuredClone(remembered.value) : await select({ ref: document.root }, keys);
        const size = value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
        if (size > document.bytes)
            throw new Error('模板状态展开字节数不一致');
        selectedBytes += size;
        if (selectedBytes > TEMPLATE_DOCUMENT_LIMIT)
            throw new Error(DOCUMENT_LIMIT_MESSAGE);
        if (!remembered) {
            const retained = size + Buffer.byteLength(key) + 64;
            selections.values.set(key, { value: freezeJson(structuredClone(value)), size: retained });
            selections.size += retained;
            trimParsed(cache);
        }
        results.push(value);
    }
    return results;
}
/**
 * 路径读取的业务校验缓存。parse 必须使用稳定函数引用、返回 JSON 值且不依赖可变外部状态；
 * 完整根、写入登记或选择路径变化后重新校验，暖读只复制已校验结果，不再遍历大型重放日志。
 * 与完整文档缓存分开：少数字段解析成功不能使随后完整读取跳过其它历史块。
 */
export async function loadTemplateDocumentPaths(fs, path, paths, parse) {
    const raw = await readRoot(fs, path), cache = storyBlocks(fs), key = JSON.stringify(paths);
    const selected = cache.selected;
    if (raw !== null && selected?.path === path && selected.raw === raw && await fs.stat(TEMPLATE_DATA_PATH)) {
        const previous = selected.parsers.get(parse);
        if (previous?.paths === key)
            return structuredClone(previous.value);
    }
    const result = parse(await readTemplateDocumentPaths(fs, path, paths));
    const current = cache.selected;
    if (raw !== null && current?.path === path && current.raw === raw) {
        const json = JSON.stringify(result), size = (json === undefined ? 0 : Buffer.byteLength(json)) + Buffer.byteLength(key) + 64, previous = current.parsers.get(parse);
        current.size -= previous?.size ?? 0;
        current.parsers.set(parse, { paths: key, value: freezeJson(structuredClone(result)), size });
        current.size += size;
        trimParsed(cache);
    }
    return result;
}
export async function loadTemplateDocument(fs, path, parse, project) {
    const copy = (value) => structuredClone(project ? project(value) : value);
    const raw = await readRoot(fs, path);
    if (raw !== null) {
        const cache = storyBlocks(fs), parsed = cache.parsed;
        // 整个块目录被移走时不沿用内存结论，让缺失在读取时就暴露。
        if (parsed && parsed.path === path && parsed.raw === raw && cache.root === raw && await fs.stat(TEMPLATE_DATA_PATH))
            return copy(parsed.value);
    }
    const loaded = await decodeRoot(fs, raw);
    const result = parse(loaded.value);
    if (loaded.cache && raw !== null)
        rememberParsed(loaded.cache, path, raw, result);
    if (project)
        return copy(loaded.cache?.parsed?.value ?? freezeJson(structuredClone(result)));
    return result;
}
