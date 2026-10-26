import { parseDocument } from 'yaml';
import { createHash } from 'node:crypto';
import { parseTemplateHelperMvu } from '../core/templateHelperMvu.js';
import { measureTemplateJson, templateExecutionBudget, TEMPLATE_INPUT_MAX_CHARS, TEMPLATE_OUTPUT_MAX_CHARS } from '../core/templateBudget.js';
import { TemplateReplayArrayPrefixes } from '../core/templateReplayArrays.js';
import { TemplateReplayJsonWriter } from '../core/templateReplayShared.js';
import { prepareTemplateCheckpointVm, createTemplateCheckpointVm, dumpTemplateCheckpointVm } from './templateCheckpointVm.js';
import { BOOTSTRAP } from './templateBootstrap.js';
import { loadTemplateRuntime } from './templateRuntime.js';
import { resolveTemplateRuntimeIdentity, TEMPLATE_RUNTIME_ABI } from '../core/templateRuntimeAbi.js';
import { hasTemplateStickyClosures, parseTemplateStickyState } from '../core/templateSticky.js';
import { parseTemplateMessageIdentities, parseTemplateMessageVariables } from '../core/templateMessageVariables.js';
import { assertTemplateReplayFormatter, measureTemplateReplay, measureTemplateReplayWork, templateReplayData, parseTemplateReplayRegexParts, parseTemplateReplayRegexBatch, TEMPLATE_REPLAY_LIMIT, TEMPLATE_REPLAY_LIMIT_HINT, TEMPLATE_REPLAY_SHARE_MIN } from '../core/templateReplay.js';
import { normalizeTemplateLore } from '../core/templateLore.js';
import { parseTemplateScopes, validateTemplateJson } from '../core/template.js';
/** 只增文本按固定长度分段；同一段历史在后续轮次得到相同分段，存储层可以复用旧块。 */
const SHARED_TEXT_SEGMENT = 16 * 1024;
function sharedTextSegments(text) {
    const segments = [];
    for (let at = 0; at < text.length;) {
        let end = Math.min(text.length, at + SHARED_TEXT_SEGMENT);
        // 不把代理对拆到两段；原文里本来孤立的代理项照常保存。
        if (end < text.length && (text.charCodeAt(end - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(end) & 0xfc00) === 0xdc00)
            end--;
        segments.push(text.slice(at, end));
        at = end;
    }
    return segments;
}
/** 一次 FFI 调用最多执行的微任务数；期限仍由批间检查与中断处理器共同保证。 */
const PENDING_JOB_BATCH = 256;
let templateLibrarySource;
let templateFakerSource;
let templateRuntimeHash;
/** 仅供 worker 编排计时，不暴露给 QuickJS 脚本。 */
let computationPhase;
/**
 * 渲染包装：完成状态与结果只存在于这个 IIFE 的闭包内，模板既不能按名字访问也不能枚举；
 * evalCode 的完成值就是这个状态对象，宿主直接持有句柄读取，因此不再依赖任何可写全局。
 * 拒绝值即使为空串也保留可读原因，不能退化成“输出无效”。
 */
const RENDER_WRAPPER = `(()=>{
const state={done:false,error:null,result:null};
const call=parseTemplateInput(__tavernCallInput);
(async()=>{
try{state.result=await __render(call.text,__sourceData(call.source,call.data))}
catch(error){state.error=(String(error)||'EJS 模板以空值拒绝')}
finally{state.done=true}
})();
return state;
})()`;
/**
 * 宿主命令入口的不可写化清单：这些全局只在 bootstrap 里赋值一次，冻结后模板无法用同名全局
 * 替换命令实现来伪造状态或结果。可被后续重新赋值的入口（如 __resetTemplateFaker）不在此列。
 */
const PROTOCOL_ENTRIES = ['__conditionState', '__export', '__exportMessageVariables', '__exportTemplateStickyState', '__restoreTemplateStickyState',
    '__render', '__setTemplateMessageContext', '__refreshTemplateContext', '__resolveTemplateOutlets', '__setTemplateOutletsDeferred',
    '__applyTemporaryRegex', '__applyTemporaryRegexSources', '__runTemporaryRegexSources', '__runBasicRegexSourcesBatch', '__regexDescriptors', '__hasMessageRegex',
    '__templateRegexRuleCount', '__templateRegexStageSize', '__prepareTemplateBasicRegex', '__clearTemplateBasicRegex', '__activationRequests', '__formatTemplateMessage',
    '__continueTemplateGeneration', '__resumeTemplateReply', '__beginTemplateGeneration', '__finishTemplateGeneration', '__hasLiveTemplateClosures',
    '__deactivateTemplateRegex', '__deactivateTemplatePromptInjection', '__sourceData', '__bindTemplateDefinitions', '__setPreparing'];
const HARDEN_PROTOCOL = `(()=>{for(const name of ${JSON.stringify(PROTOCOL_ENTRIES)}){try{
const value=globalThis[name];if(typeof value!=='function')continue;
Object.defineProperty(globalThis,name,{value,writable:false,configurable:false})}catch{}}return undefined})()`;
/**
 * @@if 状态的 toJSON 检查：每次新求值，只用 typeof、属性读取、for-in 与局部函数，不调用任何全局或原型方法，
 * 模板替换 Object/JSON/Array 也不能让它漏检。一次调用走完整棵状态，代替逐节点句柄往返；
 * 循环已由先行的 dump 拒绝，节点与深度上限沿用原口径。返回 0 通过、1 过大、2 含 toJSON。
 */
const CONDITION_STATE_CHECK = `(state)=>{let nodes=200000;
const visit=(value,depth)=>{
if(value===null||typeof value==='string'||typeof value==='boolean')return 0;
if(typeof value==='number')return value===value&&value!==1/0&&value!==-1/0?0:3;
if(typeof value!=='object')return 3;
if(--nodes<0||depth>256)return 1;
if(typeof value.toJSON==='function')return 2;
for(const key in value){const found=visit(value[key],depth+1);if(found)return found}
return 0};
return visit(state,0)}`;
export class TemplateSandbox {
    renderedSources = new Map();
    vm;
    owner;
    runtimeIdentity;
    deadline;
    resourceChars;
    outputInputChars;
    computationStarted = 0;
    initialContext;
    generationContext;
    currentContext;
    checkpoint;
    checkpointEligible = false;
    bootstrap;
    recording = false;
    operations = [];
    operationChars = 0;
    shared = [];
    sharedJson;
    /** 入参键 → 当前只增文本；累积缓冲每次只追加新增后缀。 */
    sharedTexts = new Map();
    sharedArrays = new TemplateReplayArrayPrefixes(value => this.hash(value));
    prefixArrayKeys = new Set();
    structuredArrayKeys = new Set();
    /** 阶段 → 是否完全没有临时正则；任何非只读求值都会清空。 */
    regexStageEmpty = new Map();
    /** 每次可能运行 VM 代码的求值都会递增；@@if 末态快照仅在其后没有任何求值时作为下一条条件的起点。 */
    vmEpoch = 0;
    conditionSnapshot;
    constructor(owner, deadline, resourceChars, outputInputChars, runtimeIdentity) {
        this.owner = owner;
        this.vm = owner.vm;
        this.deadline = deadline;
        this.resourceChars = resourceChars;
        this.outputInputChars = outputInputChars;
        this.runtimeIdentity = runtimeIdentity;
    }
    /** 仅预热受信任的 WASM 模块；不解析或执行第三方输入。 */
    static async prepare(onPhase) {
        computationPhase = onPhase;
        const [, runtime] = await Promise.all([prepareTemplateCheckpointVm(), loadTemplateRuntime()]);
        templateLibrarySource = runtime.librarySource;
        templateFakerSource = runtime.fakerSource;
        templateRuntimeHash = runtime.hash;
    }
    static normalizeContext(input) {
        if (input.historyIdentities)
            parseTemplateMessageIdentities(input.historyIdentities, input.history.length);
        if (input.helperMvu !== undefined)
            parseTemplateHelperMvu(input.helperMvu, input.historyIdentities ?? []);
        if (input.messageVariables) {
            parseTemplateMessageVariables(input.messageVariables);
            const visible = new Set(input.historyIdentities?.map(item => item.messageId) ?? input.history.map((_, index) => `preview:${index}`));
            if (Object.keys(input.messageVariables.snapshots).some(id => !visible.has(id)))
                throw new Error('模板包含不可见消息变量');
        }
        // YAML 解析同样发生在可终止 worker；不注册自定义 tag，限制别名展开，拒绝循环与非 JSON。
        return { ...input, entries: input.entries.map(normalizeTemplateLore).map(entry => {
                if (!entry.enabled || !/^\[InitialVariables\]/i.test(entry.comment))
                    return entry;
                const doc = parseDocument(entry.content, { uniqueKeys: true });
                if (doc.errors.length || doc.warnings.length)
                    throw new Error(`InitialVariables 解析失败：${doc.errors[0]?.message ?? doc.warnings[0]?.message}`);
                const value = doc.toJS({ maxAliasCount: 50 });
                validateTemplateJson(value);
                if (!value || typeof value !== 'object' || Array.isArray(value))
                    throw new Error('InitialVariables 必须是对象');
                return { ...entry, content: JSON.stringify(value) };
            }) };
    }
    static async create(input, record = false, bootstrap, resourceChars) {
        if (!templateRuntimeHash)
            throw new Error('模板检查点运行时尚未准备');
        const identity = resolveTemplateRuntimeIdentity({ runtimeHash: templateRuntimeHash, runtimeAbi: TEMPLATE_RUNTIME_ABI }, templateRuntimeHash);
        computationPhase?.('computing');
        const contextChars = measureTemplateJson(input);
        resourceChars = Math.max(resourceChars ?? 0, contextChars);
        const initialContext = structuredClone(input);
        input = TemplateSandbox.normalizeContext(input);
        computationPhase?.('loading');
        const owner = await createTemplateCheckpointVm();
        const vm = owner.vm;
        vm.runtime.setMemoryLimit(templateExecutionBudget(resourceChars).quickJsMemoryBytes);
        vm.runtime.setMaxStackSize(512 * 1024);
        // 受信装载（vendor 库求值、上下文初始化）给宽裕期限；第三方执行前由 beginComputation 收紧。
        const sandbox = new TemplateSandbox(owner, Date.now() + 10_000, resourceChars, contextChars, identity);
        vm.runtime.setInterruptHandler(() => Date.now() > sandbox.deadline);
        try {
            if (!templateLibrarySource)
                throw new Error('模板依赖产物缺失，请先运行 npm run build');
            if (!templateFakerSource)
                throw new Error('Faker 模板依赖产物缺失，请先运行 npm run build');
            const fakerSourceHandle = vm.newString(templateFakerSource);
            try {
                vm.setProp(vm.global, '__tavernFakerSource', fakerSourceHandle);
            }
            finally {
                fakerSourceHandle.dispose();
            }
            // 大历史作为字符串值传入，避免把 JSON 再转义成源码后交给 QuickJS 解析一次。
            const inputHandle = vm.newString(JSON.stringify(input));
            try {
                vm.setProp(vm.global, '__input', inputHandle);
            }
            finally {
                inputHandle.dispose();
            }
            const limitHandle = vm.newNumber(contextChars + 1024 * 1024);
            try {
                vm.setProp(vm.global, '__tavernOutputLimit', limitHandle);
            }
            finally {
                limitHandle.dispose();
            }
            sandbox.evaluate(BOOTSTRAP.replace('/* TEMPLATE_VENDOR */', () => templateLibrarySource));
            // 任何第三方代码（含 preload）之前冻结宿主命令入口；模板不能替换命令实现来伪造状态或结果。
            sandbox.hardenProtocol();
            if (bootstrap?.preload === 'refresh')
                sandbox.sticky('restore', bootstrap.state);
            sandbox.beginComputation();
            sandbox.preload(input);
            if (bootstrap?.preload === 'preserve')
                sandbox.sticky('restore', bootstrap.state);
            sandbox.initialContext = initialContext;
            sandbox.generationContext = initialContext;
            sandbox.currentContext = initialContext;
            sandbox.bootstrap = structuredClone(bootstrap);
            sandbox.recording = record;
            return sandbox;
        }
        catch (error) {
            vm.dispose();
            throw error;
        }
    }
    /** 重建同轮已执行的代码和词法环境；所有输入仍由 QuickJS 求值，每步校验确定性结果。 */
    static async restore(replay, context) {
        const sandbox = await TemplateSandbox.rebuild(replay);
        try {
            sandbox.resume(context);
            return sandbox;
        }
        catch (error) {
            sandbox.dispose();
            throw error;
        }
    }
    static async rebuild(replay) {
        if (replay.version !== 2)
            throw new Error('模板重放版本不兼容，需要完成或回滚旧版本楼层');
        // 外显操作哈希无法覆盖词法闭包内捕获的格式化结果；必须在任何第三方代码执行前拒绝旧引擎日志。
        assertTemplateReplayFormatter(replay);
        if (replay.context.phase !== 'generate' || !Array.isArray(replay.operations))
            throw new Error('模板重放记录无效');
        const replayChars = measureTemplateReplayWork(replay);
        // 引用在任何第三方代码执行前整批校验；展开后的入参与记录时逐字节一致。
        const data = templateReplayData(replay);
        const sandbox = replay.checkpoint ? await TemplateSandbox.fromCheckpoint(replay, replayChars)
            : await TemplateSandbox.create(replay.context, false, replay.bootstrap, replayChars);
        try {
            for (const operation of replay.operations) {
                let result;
                if (operation.kind === 'render')
                    result = sandbox.render(operation.text, data(operation), operation.source);
                else if (operation.kind === 'regexSources')
                    result = sandbox.transformRegexSources(parseTemplateReplayRegexParts(data(operation).parts), operation.stage, operation.meta, operation.namespace);
                else if (operation.kind === 'regexSourcesBatch')
                    result = sandbox.transformBasicRegexSources(parseTemplateReplayRegexBatch(data(operation).items), operation.namespace);
                else if (operation.kind === 'regex')
                    result = sandbox.transformRegex(operation.text, operation.stage, operation.meta);
                else if (operation.kind === 'variables')
                    result = sandbox.variables();
                else if (operation.kind === 'outlets')
                    result = sandbox.resolveOutlets(operation.text);
                else if (operation.kind === 'deferOutlets') {
                    sandbox.setOutletsDeferred(operation.value);
                    result = null;
                }
                else if (operation.kind === 'phase') {
                    sandbox.resume(operation.context, operation.refreshPreload);
                    result = null;
                }
                else if (operation.kind === 'phaseData') {
                    sandbox.resume(data(operation), operation.refreshPreload);
                    result = null;
                }
                else if (operation.kind === 'message')
                    result = sandbox.setMessageContext(operation.metadata);
                else if (operation.kind === 'format')
                    result = sandbox.formatMessage(operation.text);
                else if (operation.kind === 'messageVariables')
                    result = sandbox.messageVariables();
                else if (operation.kind === 'sticky')
                    result = sandbox.sticky(operation.action, operation.state);
                else
                    throw new Error('未知模板重放操作');
                if (sandbox.hash(result) !== operation.hash)
                    throw new Error('模板重放结果不一致，拒绝提交回复');
            }
            sandbox.operations = structuredClone(replay.operations);
            sandbox.adoptShared(replay);
            sandbox.operationChars = JSON.stringify(replay.operations).length + JSON.stringify(sandbox.shared).length;
            sandbox.recording = true;
            sandbox.verifyReplayState(replay);
            return sandbox;
        }
        catch (error) {
            sandbox.dispose();
            throw error;
        }
    }
    /** 只装载本插件固定 ABI 的完整隔离堆，不执行存档携带的宿主代码，也不重新运行检查点之前的脚本。 */
    static async fromCheckpoint(replay, resourceChars) {
        const checkpoint = replay.checkpoint;
        if (!templateRuntimeHash)
            throw new Error('模板检查点运行时尚未准备');
        const identity = resolveTemplateRuntimeIdentity(checkpoint, templateRuntimeHash);
        const owner = await createTemplateCheckpointVm(checkpoint.image);
        const sandbox = new TemplateSandbox(owner, Date.now() + 10_000, resourceChars, checkpoint.outputInputChars, identity);
        try {
            owner.vm.runtime.setMemoryLimit(templateExecutionBudget(resourceChars).quickJsMemoryBytes);
            owner.vm.runtime.setMaxStackSize(512 * 1024);
            owner.vm.runtime.setInterruptHandler(() => Date.now() > sandbox.deadline);
            // 旧检查点可能来自未冻结的运行时；恢复后同样冻结入口（对已冻结属性是幂等的）。
            sandbox.hardenProtocol();
            sandbox.initialContext = structuredClone(replay.context);
            sandbox.generationContext = structuredClone(replay.context);
            sandbox.currentContext = structuredClone(checkpoint.context);
            sandbox.checkpoint = structuredClone(checkpoint);
            sandbox.checkpointEligible = true;
            sandbox.beginComputation();
            return sandbox;
        }
        catch (error) {
            owner.vm.dispose();
            throw error;
        }
    }
    hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
    record(operation, result) {
        if (!this.recording)
            return;
        const stored = { ...('data' in operation ? this.shareData(operation) : structuredClone(operation)), hash: this.hash(result) };
        this.operationChars += JSON.stringify(stored).length;
        if (this.operationChars > TEMPLATE_REPLAY_LIMIT)
            throw new Error(`模板重放记录超过上限：${TEMPLATE_REPLAY_LIMIT_HINT}`);
        this.operations.push(stored);
    }
    /**
     * 每个来源求值都会带上整份模拟序列和累积缓冲；逐条内联会让日志按「来源数 × 历史」增长。
     * 大型入参移入共享表，原位置留占位以保持键顺序，重放时展开成同样的字节。
     */
    shareData(operation) {
        const data = {}, refs = {};
        for (const [key, value] of Object.entries(operation.data)) {
            const json = JSON.stringify(value);
            // JSON 不保存 undefined；求值时传入的入参同样不含该键。
            if (json === undefined)
                continue;
            if (json.length < TEMPLATE_REPLAY_SHARE_MIN) {
                data[key] = JSON.parse(json);
                continue;
            }
            data[key] = null;
            // 只有历史序列适合追加前缀；逐消息 parts 等交替数组继续按内容哈希复用，避免 A/B/A 重复落盘。
            refs[key] = typeof value === 'string' ? this.shareText(key, value, json)
                : Array.isArray(value) && ['history', 'historyIdentities', 'generateData'].includes(key) ? this.shareArray(key, value, json) : this.shareValue(json);
        }
        return { ...operation, data, ...(Object.keys(refs).length ? { refs } : {}) };
    }
    shareValue(json) {
        this.sharedJson ??= new TemplateReplayJsonWriter(this.shared, text => createHash('sha256').update(text).digest('hex'), chars => { this.operationChars += chars; });
        return this.sharedJson.write(JSON.parse(json), json);
    }
    shareText(key, value, json) {
        const current = this.sharedTexts.get(key);
        if (current && current.text.length >= value.length && current.text.startsWith(value))
            return [current.index, value.length];
        if (current && value.startsWith(current.text)) {
            const suffix = value.slice(current.text.length);
            this.shared[current.index].text.push(...sharedTextSegments(suffix));
            this.operationChars += JSON.stringify(suffix).length;
            current.text = value;
            return [current.index, value.length];
        }
        this.operationChars += json.length;
        const index = this.shared.push({ text: sharedTextSegments(value) }) - 1;
        this.sharedTexts.set(key, { index, text: value });
        return [index, value.length];
    }
    shareArray(key, value, json) {
        if (this.structuredArrayKeys.has(key))
            return this.shareValue(json);
        const current = this.sharedArrays.match(key, value);
        if (current) {
            if (current.suffix.length) {
                const suffix = JSON.stringify(current.suffix);
                const target = this.shared[current.index].array;
                for (const item of JSON.parse(suffix))
                    target.push(item);
                this.operationChars += suffix.length;
            }
            return [current.index, current.length];
        }
        // 历史裁剪或动态提示词使严格前缀失效时，转为内容共享页；只新增改动页和小根，不重存整段历史。
        if (this.prefixArrayKeys.has(key)) {
            this.structuredArrayKeys.add(key);
            return this.shareValue(json);
        }
        const values = JSON.parse(json);
        this.operationChars += json.length;
        const index = this.shared.push({ array: values }) - 1;
        this.sharedArrays.remember(key, index, values);
        this.prefixArrayKeys.add(key);
        return [index, value.length];
    }
    /** 续接已有日志时恢复去重索引，后续轮次的相同入参继续复用旧项。 */
    adoptShared(replay) {
        this.shared = structuredClone(replay.shared ?? []);
        this.sharedJson = undefined;
        const adoptedArrays = new Map();
        for (const operation of replay.operations) {
            if (!('data' in operation) || !operation.refs)
                continue;
            for (const [key, ref] of Object.entries(operation.refs)) {
                if (typeof ref === 'number' && ['history', 'historyIdentities', 'generateData'].includes(key)
                    && ('jsonArray' in this.shared[ref] || 'jsonArrayPages' in this.shared[ref]))
                    this.structuredArrayKeys.add(key);
                if (Array.isArray(ref)) {
                    const item = this.shared[ref[0]];
                    if ('array' in item) {
                        if (adoptedArrays.get(key) !== ref[0]) {
                            this.sharedArrays.remember(key, ref[0], item.array);
                            this.prefixArrayKeys.add(key);
                            adoptedArrays.set(key, ref[0]);
                        }
                    }
                    else if (this.sharedTexts.get(key)?.index !== ref[0])
                        this.sharedTexts.set(key, { index: ref[0], text: item.text.join('') });
                }
            }
        }
    }
    replay() {
        const variables = this.variables();
        const messageVariablesHash = this.hash(this.messageVariables());
        // 普通单轮日志保持紧凑 JSON；只有跨轮存活环境需要检查点。一次成功导出后清掉全部已覆盖操作。
        if (this.checkpointEligible && (this.operations.length >= 256 || this.operationChars >= 1024 * 1024))
            this.captureCheckpoint();
        const replay = { version: 2, formatterVersion: 2, context: this.initialContext, operations: this.operations,
            ...(this.shared.length ? { shared: this.shared } : {}), variables, messageVariablesHash,
            ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}),
            ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}) };
        measureTemplateReplay(replay);
        return JSON.parse(JSON.stringify(replay));
    }
    captureCheckpoint() {
        // 恢复旧兼容环境后仍使用它的真实身份，不能用当前安装包摘要冒充完成了运行时迁移。
        const next = { version: 1, ...this.runtimeIdentity, image: dumpTemplateCheckpointVm(this.owner),
            context: structuredClone(this.currentContext), outputInputChars: this.outputInputChars, resourceChars: this.resourceChars };
        // 候选整体检查成功后才替换日志；落盘仍由工作区的原子根与 WAL 负责。
        measureTemplateReplay({ version: 2, formatterVersion: 2, context: this.generationContext, checkpoint: next, operations: [] });
        this.checkpoint = next;
        this.initialContext = structuredClone(this.generationContext);
        this.bootstrap = undefined;
        this.operations = [];
        this.shared = [];
        this.operationChars = 0;
        this.sharedJson = undefined;
        this.sharedTexts.clear();
        this.sharedArrays.clear();
        this.prefixArrayKeys.clear();
        this.structuredArrayKeys.clear();
    }
    /** readonly 仅用于不改变沙箱状态的固定查询；其余求值都可能运行第三方代码并改动规则表。 */
    evaluate(code, readonly = false) {
        this.vmEpoch++;
        if (!readonly)
            this.regexStageEmpty.clear();
        const result = this.vm.evalCode(code);
        if (result.error) {
            const error = this.vm.dump(result.error);
            result.error.dispose();
            throw new Error(`EJS 模板失败：${JSON.stringify(error)}`);
        }
        try {
            return this.vm.dump(result.value);
        }
        finally {
            result.value.dispose();
        }
    }
    /** 纯 JSON 作为 QuickJS 字符串值传输，固定源码不再重复解析转义后的大历史。 */
    evaluateInput(code, input, readonly = false) {
        const json = JSON.stringify(input);
        if (json.length > TEMPLATE_INPUT_MAX_CHARS)
            throw new Error('模板调用输入超过安全资源容量');
        this.growResources(json.length);
        const handle = this.vm.newString(json);
        try {
            this.vm.setProp(this.vm.global, '__tavernCallInput', handle);
            return this.evaluate(code, readonly);
        }
        finally {
            this.vm.setProp(this.vm.global, '__tavernCallInput', this.vm.undefined);
            handle.dispose();
        }
    }
    /** 同 evaluateInput，但把完成值句柄留给调用方（渲染状态必须由宿主持有，不能经全局中转）。 */
    evaluateHandle(code, input) {
        // 与 evaluate(code,false) 同语义：包装里会执行第三方代码，可能改动临时正则表，必须失效阶段缓存。
        this.vmEpoch++;
        this.regexStageEmpty.clear();
        const json = JSON.stringify(input);
        if (json.length > TEMPLATE_INPUT_MAX_CHARS)
            throw new Error('模板调用输入超过安全资源容量');
        this.growResources(json.length);
        const handle = this.vm.newString(json);
        try {
            this.vm.setProp(this.vm.global, '__tavernCallInput', handle);
            const result = this.vm.evalCode(code);
            if (result.error) {
                const error = this.vm.dump(result.error);
                result.error.dispose();
                throw new Error(`EJS 模板失败：${JSON.stringify(error)}`);
            }
            return result.value;
        }
        finally {
            this.vm.setProp(this.vm.global, '__tavernCallInput', this.vm.undefined);
            handle.dispose();
        }
    }
    /** 只读取闭包状态；不经过模板可命名的全局，也不调用任何模板可补丁的函数。 */
    readRenderState(state) {
        const read = (key) => {
            const handle = this.vm.getProp(state, key);
            try {
                return this.vm.dump(handle);
            }
            finally {
                handle.dispose();
            }
        };
        const done = read('done'), error = read('error');
        return { done: done === true, error: typeof error === 'string' && error ? error : null, result: read('result') };
    }
    /** 真实错误优先于期限：QuickJS 的 OOM/内部错误不能被一律报成超时，只有中断本身按超期收口。 */
    renderFailure(message) {
        if (/interrupt/i.test(message) && Date.now() > this.deadline)
            return new Error('EJS 模板计算超时');
        return new Error(`EJS 模板失败：${message}`);
    }
    /** 冻结宿主命令入口；对已冻结属性幂等，旧堆里的可写实现会被一并收紧。 */
    hardenProtocol() { this.evaluate(HARDEN_PROTOCOL); }
    /**
     * 宿主侧直接读取内部状态并在主线程比较：不再经过模板可命名的 __conditionState，
     * 也不使用 VM 内可被补丁的 JSON.stringify。vm.dump 走 JSON 语义会调用对象的 toJSON，
     * 模板可借此让快照恒定；因此 dump 后用新求值的纯语法检查遍历同一状态，带 toJSON 的状态直接拒绝。
     */
    conditionState() {
        // 读取属性会触发 getter/Proxy 等模板代码；与 evaluate 一致失效阶段缓存。
        this.regexStageEmpty.clear();
        const object = this.vm.evalCode('({scopes,variables,initial,messageSnapshots})');
        if (object.error) {
            const error = this.vm.dump(object.error);
            object.error.dispose();
            throw new Error(`@@if 条件状态读取失败：${JSON.stringify(error)}`);
        }
        try {
            this.assertPlainState(object.value);
            let dumped;
            try {
                dumped = this.vm.dump(object.value);
            }
            catch (error) {
                throw new Error(`@@if 条件状态读取失败：${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                return JSON.stringify(dumped);
            }
            catch {
                throw new Error('@@if 条件状态不可序列化，拒绝求值');
            }
        }
        finally {
            object.value.dispose();
        }
    }
    /** 状态里的对象节点必须没有 toJSON（含原型链）或非 JSON 值，dump 的键集合才是真实的可枚举属性。 */
    assertPlainState(state) {
        const check = this.vm.evalCode(CONDITION_STATE_CHECK);
        if (check.error) {
            const error = this.vm.dump(check.error);
            check.error.dispose();
            throw new Error(`@@if 条件状态读取失败：${JSON.stringify(error)}`);
        }
        try {
            const result = this.vm.callFunction(check.value, this.vm.undefined, state);
            if (result.error) {
                const error = this.vm.dump(result.error);
                result.error.dispose();
                throw new Error(`@@if 条件状态读取失败：${JSON.stringify(error)}`);
            }
            const code = this.vm.getNumber(result.value);
            result.value.dispose();
            if (code === 1)
                throw new Error('@@if 条件状态过大，拒绝求值');
            if (code === 3)
                throw new Error('@@if 条件状态不可序列化，拒绝求值');
            if (code !== 0)
                throw new Error('@@if 条件状态含自定义 toJSON，拒绝求值');
        }
        finally {
            check.value.dispose();
        }
    }
    growResources(inputChars) {
        if (inputChars > this.outputInputChars) {
            this.outputInputChars = inputChars;
            const limitHandle = this.vm.newNumber(inputChars + 1024 * 1024);
            try {
                this.vm.setProp(this.vm.global, '__tavernOutputLimit', limitHandle);
            }
            finally {
                limitHandle.dispose();
            }
            this.evaluate('templateOutputLimit=__tavernOutputLimit', true);
        }
        if (inputChars > this.resourceChars) {
            this.resourceChars = inputChars;
            const budget = templateExecutionBudget(inputChars);
            this.vm.runtime.setMemoryLimit(budget.quickJsMemoryBytes);
            // 扩大输入只调整从本阶段起点算的期限，不能靠反复调用重新获得完整执行时长。
            if (this.computationStarted)
                this.deadline = this.computationStarted + budget.sandboxMs;
        }
    }
    /** 受信装载结束后收紧到第三方计算预算；后续阶段（resume/继续轮）重置同一预算。 */
    beginComputation() {
        computationPhase?.('computing');
        this.computationStarted = Date.now();
        this.deadline = this.computationStarted + templateExecutionBudget(this.resourceChars).sandboxMs;
    }
    /** 精确日志命中后开始新的隔离任务；只重置执行预算，保留已验证日志所对应的词法环境。 */
    restartBudget(resourceChars) {
        this.resourceChars = resourceChars;
        this.vm.runtime.setMemoryLimit(templateExecutionBudget(resourceChars).quickJsMemoryBytes);
        this.beginComputation();
    }
    /** 冷暖恢复都执行相同末态校验；变量 schema 与帧同步可运行脚本，不能把这些查询当成无副作用跳过。 */
    verifyReplayState(replay) {
        const recording = this.recording;
        let variables, messageVariables;
        this.recording = false;
        try {
            variables = this.variables();
            if (JSON.stringify(variables) !== JSON.stringify(replay.variables))
                throw new Error('模板重放最终变量不一致');
            messageVariables = this.messageVariables();
            if (this.hash(messageVariables) !== replay.messageVariablesHash)
                throw new Error('模板重放历史消息变量不一致');
        }
        finally {
            this.recording = recording;
        }
        // 只登记刚刚真实执行的两次查询，不再次求值；否则后续冷恢复会漏掉历史 schema 校验的闭包副作用。
        if (this.recording) {
            // 这两条固定记录先作为校验尾部保留：下一轮可能立即释放最后到期闭包。
            // 在确认仍需日志的正常 record/replay 处统一限长，避免清理尚未运行就再次卡在旧容量边缘。
            for (const [kind, result] of [['variables', variables], ['messageVariables', messageVariables]]) {
                const operation = { kind, hash: this.hash(result) };
                this.operationChars += JSON.stringify(operation).length;
                this.operations.push(operation);
            }
        }
    }
    preload(context) {
        const recording = this.recording;
        this.recording = false;
        try {
            this.evaluate('__setPreparing(true)');
            for (const entry of context.entries.filter(e => e.enabled && e.templatePreload).sort((a, b) => a.order - b.order)) {
                if (!entry.templateCondition || this.condition(entry.templateCondition))
                    this.render(entry.content, {}, entry.key);
            }
            this.evaluate('__setPreparing(false)');
        }
        finally {
            this.recording = recording;
        }
    }
    resume(context, refreshPreload = false) {
        this.beginComputation();
        const normalized = TemplateSandbox.normalizeContext(context);
        if (context.phase === 'generate') {
            if (normalized.messageVariables) {
                const known = new Set([
                    ...(this.currentContext.historyIdentities?.map(item => item.messageId) ?? this.currentContext.history.map((_, index) => `preview:${index}`)),
                    ...Object.keys(this.currentContext.messageVariables?.snapshots ?? {}),
                ]);
                if (Object.keys(normalized.messageVariables.snapshots).some(id => !known.has(id))) {
                    throw new Error('模板跨轮历史变量与已提交状态不一致');
                }
            }
            this.evaluateInput('__continueTemplateGeneration(parseTemplateInput(__tavernCallInput))', normalized);
            this.renderedSources.clear();
            if (refreshPreload)
                this.preload(normalized);
        }
        else
            this.evaluateInput('__resumeTemplateReply(parseTemplateInput(__tavernCallInput))', normalized);
        this.currentContext = structuredClone(context);
        if (context.phase === 'generate') {
            this.generationContext = this.currentContext;
            this.checkpointEligible = true;
        }
        this.record({ kind: 'phaseData', data: { ...context }, refreshPreload }, null);
    }
    /** 先判定旧闭包是否全部到期；可释放日志时不能让用于清理的两条记录撞上旧预算。 */
    advanceGeneration(context, refreshPreload) {
        const recording = this.recording;
        this.recording = false;
        try {
            this.resume(context, refreshPreload);
            const remaining = this.sticky('begin');
            this.recording = recording;
            if (hasTemplateStickyClosures(remaining)) {
                this.record({ kind: 'phaseData', data: { ...context }, refreshPreload }, null);
                this.record({ kind: 'sticky', action: 'begin' }, remaining);
            }
            return remaining;
        }
        finally {
            this.recording = recording;
        }
    }
    stickyState() {
        const raw = this.evaluate('__exportTemplateStickyState()');
        if (typeof raw !== 'string')
            throw new Error('sticky 导出无效');
        return parseTemplateStickyState(JSON.parse(raw));
    }
    sticky(action, state) {
        if (action === 'restore') {
            if (!state)
                throw new Error('sticky 恢复缺少状态');
            this.evaluate(`__restoreTemplateStickyState(${JSON.stringify(parseTemplateStickyState(state))})`);
        }
        else
            this.evaluate(action === 'begin' ? '__beginTemplateGeneration()' : '__finishTemplateGeneration()');
        const result = this.stickyState();
        this.record({ kind: 'sticky', action, ...(state ? { state } : {}) }, result);
        return result;
    }
    render(text, data = {}, source) {
        // 完成状态只存在于包装闭包内；模板写 globalThis.__done/__result 一类同名全局不再有任何作用。
        const state = this.evaluateHandle(RENDER_WRAPPER, { text, data, source });
        try {
            while (this.vm.runtime.hasPendingJob()) {
                if (Date.now() > this.deadline) {
                    const pending = this.readRenderState(state);
                    if (pending.error)
                        throw this.renderFailure(pending.error);
                    throw new Error('EJS 模板计算超时');
                }
                // 成批执行微任务，批间复查期限；批内超期由中断处理器终止当前任务，不必逐个往返 FFI。
                const result = this.vm.runtime.executePendingJobs(PENDING_JOB_BATCH);
                if (result.error) {
                    const error = this.vm.dump(result.error);
                    result.error.dispose();
                    const message = JSON.stringify(error);
                    if (/interrupt/i.test(message) && Date.now() > this.deadline)
                        throw new Error('EJS 模板计算超时');
                    throw new Error(`EJS 异步任务失败：${message}`);
                }
            }
            // 先读真实结果：期限已过但脚本已明确失败时必须报真实原因（OOM/内部错误），不能一律报超时。
            const outcome = this.readRenderState(state);
            if (outcome.error)
                throw this.renderFailure(outcome.error);
            if (Date.now() > this.deadline)
                throw new Error('EJS 模板计算超时');
            if (!outcome.done)
                throw new Error('EJS 异步任务未完成（不允许外部 I/O）');
            const value = outcome.result;
            if (typeof value !== 'string' || value.length > this.outputInputChars + 1024 * 1024)
                throw new Error('EJS 输出无效或净增超过 1 MiB 上限');
            this.record({ kind: 'render', text, data, source }, value);
            return value;
        }
        finally {
            state.dispose();
        }
    }
    /** 重组同轮计划时只重放已求值的来源，避免 activewi 引起脚本重复写变量。 */
    renderSource(text, source, data = {}) {
        if (this.renderedSources.has(source))
            return this.renderedSources.get(source);
        const value = this.render(text, data, source);
        this.renderedSources.set(source, value);
        return value;
    }
    activationRequests() {
        const raw = this.evaluate('__activationRequests()', true);
        if (typeof raw !== 'string')
            throw new Error('模板激活请求无效');
        return JSON.parse(raw);
    }
    /**
     * 这条消息在该阶段是否有临时正则。没有规则时变换恒等且不执行任何第三方代码，
     * 调用方直接沿用原文：不进入 EJS，也不留下随消息数增长的重放记录。只读查询本身不入日志。
     */
    hasRegexStage(stage) {
        // 整个阶段没有规则是最常见的情况：结论沿用到下一次可能改动规则的求值，逐条消息不再询问沙箱。
        let empty = this.regexStageEmpty.get(stage);
        if (empty === undefined) {
            const count = this.evaluate(`__templateRegexStageSize(${JSON.stringify(stage)})`, true);
            if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
                throw new Error('临时正则规则计数无效');
            empty = count === 0;
            this.regexStageEmpty.set(stage, empty);
        }
        return !empty;
    }
    hasRegexRules(stage, meta) {
        if (!this.hasRegexStage(stage))
            return false;
        const count = this.evaluate(`__templateRegexRuleCount(${JSON.stringify(stage)},${JSON.stringify(meta)})`, true);
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)
            throw new Error('临时正则规则计数无效');
        return count > 0;
    }
    transformRegex(text, stage, meta) {
        if (!this.hasRegexRules(stage, meta))
            return text;
        const result = this.evaluate(`__applyTemporaryRegex(${JSON.stringify(text)},${JSON.stringify(stage)},${JSON.stringify(meta)})`);
        if (typeof result !== 'string')
            throw new Error('临时正则返回值无效');
        this.record({ kind: 'regex', text, stage, meta }, result);
        return result;
    }
    transformRegexSources(parts, stage, meta, cacheNamespace) {
        if (typeof cacheNamespace !== 'string' || cacheNamespace.length > 4096)
            throw new Error('正则来源命名空间无效或超限');
        parseTemplateReplayRegexParts(parts);
        if (!this.hasRegexStage(stage))
            return parts.map(part => ({ ...part }));
        const raw = this.evaluateInput('(()=>{const call=parseTemplateInput(__tavernCallInput);return __runTemporaryRegexSources(call.parts,call.stage,call.meta,call.namespace)})()', { parts, stage, meta, namespace: cacheNamespace });
        if (typeof raw !== 'string')
            throw new Error('正则来源结果无效');
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || !('applied' in value) || typeof value.applied !== 'boolean' || !('parts' in value))
            throw new Error('正则来源结果无效');
        const result = parseTemplateReplayRegexParts(value.parts);
        if (value.applied)
            this.record({ kind: 'regexSources', stage, meta, namespace: cacheNamespace, data: { parts } }, result);
        return result;
    }
    /** basic 全包在任何消息来源求值之前完成，且只允许文本替换；一次调用保持原先逐消息的来源映射。 */
    transformBasicRegexSources(items, cacheNamespace) {
        if (typeof cacheNamespace !== 'string' || cacheNamespace.length > 4096)
            throw new Error('正则来源命名空间无效或超限');
        parseTemplateReplayRegexBatch(items);
        if (!this.hasRegexStage('basic'))
            return items.map(item => item.parts.map(part => ({ ...part })));
        const raw = this.evaluateInput('(()=>{const call=parseTemplateInput(__tavernCallInput);return __runBasicRegexSourcesBatch(call.items,call.namespace)})()', { items, namespace: cacheNamespace });
        if (typeof raw !== 'string')
            throw new Error('basic 正则批次结果无效');
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object' || !('applied' in value) || typeof value.applied !== 'boolean' || !('parts' in value)
            || !Array.isArray(value.parts) || value.parts.length !== items.length)
            throw new Error('basic 正则批次结果无效');
        const result = value.parts.map(parts => parseTemplateReplayRegexParts(parts));
        if (value.applied)
            this.record({ kind: 'regexSourcesBatch', namespace: cacheNamespace, data: { items } }, result);
        return result;
    }
    regexDescriptors() {
        const raw = this.evaluate('__regexDescriptors()');
        if (typeof raw !== 'string')
            throw new Error('临时正则描述无效');
        return JSON.parse(raw);
    }
    hasMessageRegex() { return this.evaluate('__hasMessageRegex()') === true; }
    formatMessage(text) {
        const result = this.evaluateInput('__formatTemplateMessage(parseTemplateInput(__tavernCallInput))', text);
        if (typeof result !== 'string' || result.length > Math.min(TEMPLATE_OUTPUT_MAX_CHARS, text.length * 16 + 1024 * 1024))
            throw new Error('模板消息格式化输出超过安全资源容量');
        this.record({ kind: 'format', text }, result);
        return result;
    }
    setMessageContext(metadata) {
        const result = this.evaluate(`__setTemplateMessageContext(${JSON.stringify(metadata)})`);
        this.record({ kind: 'message', metadata }, result);
        return result;
    }
    setOutletsDeferred(value) {
        this.evaluate(`__setTemplateOutletsDeferred(${JSON.stringify(value)})`);
        this.record({ kind: 'deferOutlets', value }, null);
    }
    resolveOutlets(text) {
        const result = this.evaluate(`__resolveTemplateOutlets(${JSON.stringify(text)})`);
        if (typeof result !== 'string')
            throw new Error('模板注入出口返回无效');
        this.record({ kind: 'outlets', text }, result);
        return result;
    }
    variables() {
        const raw = this.evaluate('__export()');
        if (typeof raw !== 'string' || raw.length > 1024 * 1024)
            throw new Error('模板变量超过 1 MiB 上限');
        const result = parseTemplateScopes(JSON.parse(raw));
        this.record({ kind: 'variables' }, result);
        return result;
    }
    messageVariables() {
        const raw = this.evaluate('__exportMessageVariables()');
        if (typeof raw !== 'string')
            throw new Error('消息变量导出无效');
        const result = parseTemplateMessageVariables(JSON.parse(raw));
        this.record({ kind: 'messageVariables' }, result);
        return result;
    }
    /** 条件在 WI 预算和分组前求值；拒绝写变量，避免预选阶段产生未提交或重复副作用。 */
    condition(expression) {
        // 上一条条件之后没有任何求值时，VM 状态未变，其末态快照即本条起点；连续的 WI 条件每条只取一次快照。
        const cached = this.conditionSnapshot;
        const before = cached && cached.epoch === this.vmEpoch ? cached.state : this.conditionState();
        const result = this.render(`<%- Boolean(${expression}) %>`);
        const after = this.conditionState();
        if (after !== before)
            throw new Error('@@if 条件必须只读，不能修改变量');
        this.conditionSnapshot = { epoch: this.vmEpoch, state: after };
        return result === 'true';
    }
    dispose() { this.vm.dispose(); }
}
