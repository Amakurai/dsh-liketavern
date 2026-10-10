/**
 * 记忆的检索别名：提示词、回复解析与别名文件格式（纯函数）。
 *
 * 检索只看字面：问「谁在偷药」找不到写着「止痛剂少了两箱」的记忆。写入之后、空闲时让模型为每条记忆
 * 补几个别名——其中的名字、正文里没有的同义说法和类别、别人问起时会用的词——检索时与 keys 一样参与匹配。
 * 别名是派生数据：单独存成一个文件，按正文指纹对应到记忆；正文一改，旧别名自动作废，等下一次空闲重新生成。
 * 不改记忆文件本身，不进 WAL，丢了可以重建。
 */
import { isSeparatorChar, isStopBigram, isStopWord } from './stopwords.js';
import { analyzeText, isKana } from './tokenize.js';
/** 每条记忆最多保留的别名数与单个别名的长度上限（字）。 */
export const ALIAS_LIMIT = 8;
export const ALIAS_MAX_CHARS = 16;
/** 一次请求最多处理的记忆条数：控制单次辅助调用的长度，存量记忆分多次空闲补完。 */
export const ALIAS_BATCH = 12;
/** 让模型为一批记忆写别名的提示词；序号从 1 起，与 parseAliasReply 对应。 */
export function buildAliasPrompt(bodies) {
    const entries = bodies.map((body, index) => `【${index + 1}】${body.replace(/\s+/g, ' ').trim()}`).join('\n');
    return [
        '下面是角色扮演中记下的若干条记忆。请为每一条写出检索用的别名，让以后换一种说法问起时也能找到它。',
        `每条写 3 到 ${ALIAS_LIMIT} 个，每个不超过 ${ALIAS_MAX_CHARS} 个字：`,
        '- 这条记忆里的人名、物名、地名；只有一个字的名字也要单独列出。',
        '- 正文里没有出现的同义说法和所属类别（正文写“止痛剂”，可以写“药”“药品”）。',
        '- 别人问起这件事时可能用到的词（正文写“少了两箱”，可以写“失窃”“偷药”）。',
        '别名使用与该条记忆相同的语言。不要解释，不要照抄整句正文，不要写“他、这件事”之类的代词。',
        '输出格式：每条记忆一行，“序号: 别名、别名、别名”，不要输出别的内容。',
        '',
        entries,
    ].join('\n');
}
/** 别名两端要去掉的字符：空白、引号、括号、列表符号；末尾另外去掉句读。 */
const WRAP = '\\s"\'“”‘’「」『』《》〈〉()（）\\[\\]【】<>*`·•';
const WRAPPERS = new RegExp(`^[${WRAP}\\-—]+|[${WRAP}。.．,，;；:：!！?？]+$`, 'gu');
/**
 * 清理一组别名：去掉包裹的引号括号与首尾标点，丢掉过长、空白、与正文相同、重复的，以及不该成为检索词的——
 * 单个虚词或假名、功能词（别名与 key 一样会把单个字、单个词声明为词，「什么」「他」混进来会让它们从此参与每次检索）。
 */
export function normalizeAliases(raw, body) {
    const seen = new Set();
    const aliases = [];
    const whole = body.trim().toLowerCase();
    for (const item of raw) {
        if (typeof item !== 'string')
            continue;
        const alias = item.normalize('NFKC').replace(/\s+/g, ' ').replace(WRAPPERS, '');
        if (!alias || [...alias].length > ALIAS_MAX_CHARS)
            continue;
        const identity = alias.toLowerCase();
        if (identity === whole || seen.has(identity))
            continue;
        const tokens = analyzeText(alias);
        // 切不出任何检索词（纯标点、纯表情）
        if (tokens.terms.length === 0 && tokens.chars.length === 0)
            continue;
        if (tokens.terms.length === 0 && tokens.chars.every((char) => isSeparatorChar(char) || isKana(char)))
            continue;
        if (tokens.terms.length > 0 && tokens.terms.every((term) => isStopBigram(term) || isStopWord(term)))
            continue;
        seen.add(identity);
        aliases.push(alias);
        if (aliases.length >= ALIAS_LIMIT)
            break;
    }
    return aliases;
}
/**
 * 行首的序号：`1:`、`1.`、`1、`、`1)`，或括起来的 `【1】`、`[1]`、`(1)`（后面可再跟一个冒号）。
 * 数字后面必须有分隔符：「3 个别名如下」这样的句子不算。
 */
const LINE = /^\s*(?:[-*•]\s*)?(?:[【[(（]\s*(\d{1,3})\s*[】\])）]\s*[:：]?|(\d{1,3})\s*[:：.．、)）])\s*(.*)$/u;
const SEPARATORS = /[、,，;；|｜/／\t]+/u;
/**
 * 解析模型回复：返回与输入等长的数组，没有对应行的位置为 null。
 * 同一序号出现多次只取第一次；序号越界、没有序号的行一律忽略——宁可少要，也不把解释性的话当成别名。
 */
export function parseAliasReply(text, bodies) {
    const result = bodies.map(() => null);
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
        const match = LINE.exec(line);
        if (!match)
            continue;
        const index = Number(match[1] ?? match[2]) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= bodies.length || result[index] !== null)
            continue;
        result[index] = normalizeAliases(match[3].split(SEPARATORS), bodies[index]);
    }
    return result;
}
/** 别名文件 → 记忆 id 到记录的映射。文件是派生数据：格式不对的整份或单条直接丢弃，等以后重新生成。 */
export function parseAliasFile(text) {
    const records = new Map();
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        return records;
    }
    const entries = data?.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries))
        return records;
    for (const [id, value] of Object.entries(entries)) {
        const record = value;
        if (!record || typeof record.hash !== 'string' || !record.hash || !Array.isArray(record.aliases))
            continue;
        // 文件可能被手改：别名按写入时同样的规则再过一遍。正文不在手边，「与正文相同」那一条在写入时已经查过。
        records.set(id, { hash: record.hash, aliases: normalizeAliases(record.aliases, '') });
    }
    return records;
}
export function serializeAliasFile(records) {
    const entries = {};
    for (const id of [...records.keys()].sort())
        entries[id] = records.get(id);
    return JSON.stringify({ version: 1, entries }, null, 2) + '\n';
}
