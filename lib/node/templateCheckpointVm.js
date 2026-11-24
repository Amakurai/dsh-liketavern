/** 专属 QuickJS/WASM 堆的版本固定快照；只恢复本插件无宿主函数桥的静止 VM，绝不执行存档提供的宿主源码或 WASM。 */
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { loadTemplateCheckpointEngine } from './templateCheckpointEngine.js';
import { templateCheckpointMemory } from './templateCheckpointMemory.js';
import { TEMPLATE_CHECKPOINT_ENGINE, TEMPLATE_CHECKPOINT_WASM_HASH, TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES, TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES, TEMPLATE_CHECKPOINT_COMPRESSED_MAX_BYTES, parseTemplateCheckpointVmImage, TEMPLATE_CHECKPOINT_PAGE_BYTES, TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES } from '../core/templateCheckpoint.js';
const owners = new WeakMap();
const STACK_POINTER = 5333088;
/** WASM 线性内存的静态区、栈与内置 vendor 基线余量；叠加 quickJsMemoryBytes 倍率后仍受检查点硬上限约束。 */
const WASM_BASELINE_BYTES = 32 * 1024 * 1024;
/** 精确 ABI 的全部 imports。堆摘要只校完整性；任意伪造 C 指针也不能借表内包装器取得宿主副作用。 */
const IMPORT_NAMES = 'abcdefghijklmnopqrst'.split('');
const FORBIDDEN_IMPORTS = new Set('bcghjlqrst'.split(''));
const ZERO_PAGE = new Uint8Array(TEMPLATE_CHECKPOINT_PAGE_BYTES);
let compiled;
function checkpointImports(module, imports, limit) {
    const definitions = WebAssembly.Module.imports(module), namespace = imports.a;
    if (definitions.length !== IMPORT_NAMES.length || Object.keys(imports).length !== 1 || !namespace
        || Object.keys(namespace).length !== IMPORT_NAMES.length || IMPORT_NAMES.some(name => !Object.hasOwn(namespace, name))
        || definitions.some(item => item.module !== 'a' || !IMPORT_NAMES.includes(item.name) || item.kind !== (item.name === 'a' ? 'memory' : 'function'))
        || !(namespace.a instanceof WebAssembly.Memory)
        || IMPORT_NAMES.some(name => name !== 'a' && typeof namespace[name] !== 'function'))
        throw new Error('模板检查点 WASM 导入布局不兼容');
    const restricted = { ...namespace };
    // b/q 原实现会解码断言指针并打印；c/j/l/r 是输出/定时器/退出，g/h/s/t 是模板禁用的宿主桥。
    for (const name of FORBIDDEN_IMPORTS)
        restricted[name] = () => {
            throw new Error(name === 'b' || name === 'q'
                ? '模板检查点引擎内部错误（断言或内存异常）' : '模板检查点禁止宿主副作用');
        };
    // 冻结引擎的 malloc_usable_size 不可用，QuickJS setMemoryLimit 无法计入分块分配；
    // 在 Emscripten 堆扩容入口 k (_emscripten_resize_heap) 施加线性内存硬上限，拒绝后返回 false 让 QuickJS 正常抛 OOM。
    const originalResize = namespace.k;
    restricted.k = (requested) => {
        if ((requested >>> 0) > limit.wasmByteLimit)
            return false;
        return originalResize(requested);
    };
    return { a: restricted };
}
/** 从随插件保留的受信 v1 引擎编译；依赖更新不替换旧检查点所需的 WASM、胶水层或包装器。 */
async function prepare() {
    const { wasmBytes } = await loadTemplateCheckpointEngine();
    return WebAssembly.compile(wasmBytes);
}
function compiledModule() {
    if (!compiled) {
        const pending = prepare().catch(error => {
            if (compiled === pending)
                compiled = undefined;
            throw error;
        });
        compiled = pending;
    }
    return compiled;
}
export async function prepareTemplateCheckpointVm() { await compiledModule(); }
/** 同步收紧或放宽专属 WASM 线性内存上限；不会低于当前已分配页数，也不超过检查点硬上限。 */
export function setTemplateCheckpointVmMemoryLimit(vm, quickJsMemoryBytes) {
    const internal = owners.get(vm);
    if (!internal)
        return;
    // dlmalloc 碎片与 markdown-it / 长串编译瞬时峰值为逻辑预算的 2–3 倍；3x 乘数兼顾 4 MiB 合法渲染与硬上限防 OOB。
    const target = Math.max(internal.memory.buffer.byteLength, WASM_BASELINE_BYTES + quickJsMemoryBytes * 3);
    internal.limit.wasmByteLimit = Math.min(TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES, target);
}
/** 宿主 FFI（入参编码、错误格式化、dispose）期间临时提供少量 WASM 扩容余量，防止 _malloc 返回 NULL 触发 OOB。 */
export function withTemplateCheckpointVmHeadroom(vm, extraBytes, fn) {
    const internal = owners.get(vm);
    if (!internal)
        return fn();
    const prev = internal.limit.wasmByteLimit;
    internal.limit.wasmByteLimit = Math.min(TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES, Math.max(prev, internal.memory.buffer.byteLength + extraBytes));
    try {
        return fn();
    }
    finally {
        internal.limit.wasmByteLimit = prev;
    }
}
function handles(vm) {
    const bridge = vm;
    // global 必须在任何动态输入或业务求值前分配；其余四个原始值指向固定静态区。
    return { runtime: bridge.runtime.rt.value, context: bridge.ctx.value, uint32: bridge.uint32Out.value.ptr, global: vm.global.value,
        undefined: vm.undefined.value, null: vm.null.value, false: vm.false.value, true: vm.true.value };
}
function sameHandles(left, right) {
    return Object.keys(left).every(key => left[key] === right[key]);
}
/** WASM memory.grow() 会使旧 ArrayBuffer 分离；将 typedArray 改为按当前 memory.buffer 按需重绑定视图的读取器。 */
function bindLiveTypedArray(target, memory) {
    if (!target || typeof target !== 'object')
        return;
    const initial = target.typedArray;
    if (!ArrayBuffer.isView(initial))
        return;
    const ptr = typeof target.ptr === 'number' ? target.ptr : initial.byteOffset;
    const length = initial.length;
    const Ctor = initial.constructor;
    let current = initial;
    Object.defineProperty(target, 'typedArray', {
        configurable: true,
        enumerable: true,
        get() {
            const buffer = memory.buffer;
            if (current.buffer !== buffer)
                current = new Ctor(buffer, ptr, length);
            return current;
        },
    });
}
function patchLiveTypedArrays(vm, memory) {
    const bridge = vm;
    bindLiveTypedArray(bridge.uint32Out?.value, memory);
    for (const holder of [bridge.memory, bridge.runtime?.memory]) {
        if (!holder || typeof holder.newTypedArray !== 'function')
            continue;
        const original = holder.newTypedArray;
        holder.newTypedArray = function (...args) {
            const lifetime = original.apply(this, args);
            if (lifetime?.value)
                bindLiveTypedArray(lifetime.value, memory);
            return lifetime;
        };
    }
}
function assertOwned(owner) {
    const internal = owners.get(owner.vm);
    if (!internal || internal.engine !== owner.engine || !owner.vm.alive)
        throw new Error('模板检查点 VM 归属无效');
    const bridge = owner.vm, engine = owner.engine;
    if (bridge.runtime.contextMap.size !== 1 || bridge.runtime.context !== owner.vm || engine.callbacks.contextCallbacks.size !== 1 || engine.callbacks.runtimeCallbacks.size !== 1
        || bridge.runtime.hostRefs.groups.size !== 0 || bridge.runtime.hostRefs.nextId !== -2147483648 || bridge.runtime.hostRefs.freelist.length !== 0
        || bridge.runtime.moduleLoader !== undefined || bridge.runtime.moduleNormalizer !== undefined)
        throw new Error('模板检查点不允许额外上下文或宿主函数桥');
    if (bridge._BigInt !== undefined || bridge._Symbol !== undefined || bridge._SymbolIterator !== undefined || bridge._SymbolAsyncIterator !== undefined
        || bridge.memory.scope._disposables.value.size !== 4 || !sameHandles(internal.handles, handles(owner.vm)))
        throw new Error('模板检查点包装器句柄布局已改变');
    // 内部 Promise/async jobs 及悬挂帧都在此专属 C 堆；保留原队列，不能提前 drain 改变脚本时序。
    // 静止要求没有正在执行的 C 栈；受控调用方不使用 newPromise/resolvePromise 宿主异步桥。
    // hostRefs 检查和受限 imports 另行拒绝函数桥，不能把队列非空误当成外部 I/O。
    if (internal.stackPointer() !== STACK_POINTER)
        throw new Error('模板检查点必须在 C 栈静止点创建');
    return internal;
}
export async function createTemplateCheckpointVm(value) {
    const image = value === undefined ? undefined : parseTemplateCheckpointVmImage(value);
    const module = await compiledModule();
    const { newQuickJSWASMModule, newVariant, RELEASE_SYNC } = await loadTemplateCheckpointEngine();
    const memory = new WebAssembly.Memory({ initial: (image?.memoryBytes ?? TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES) / 65536, maximum: TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES / 65536 });
    const limit = { wasmByteLimit: TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES };
    let exports;
    let rejectInstantiation;
    const failed = new Promise((_resolve, reject) => { rejectInstantiation = reject; });
    const engine = await Promise.race([newQuickJSWASMModule(newVariant(RELEASE_SYNC, { wasmMemory: memory,
            emscriptenModule: { instantiateWasm: (imports, onSuccess) => {
                    try {
                        void WebAssembly.instantiate(module, checkpointImports(module, imports, limit)).then(instance => { exports = instance.exports; onSuccess(instance); }, rejectInstantiation);
                    }
                    catch (error) {
                        rejectInstantiation(error);
                    }
                    return {};
                } },
        })), failed]);
    const stackPointer = exports?.Oa;
    // Oa 是此精确 WASM SHA 的 stackSave 导出；唯一可变 global 为 i32 栈指针，静止值必须匹配。
    if (typeof stackPointer !== 'function' || stackPointer() !== STACK_POINTER)
        throw new Error('模板检查点 WASM 栈布局不兼容');
    const vm = engine.newContext();
    patchLiveTypedArrays(vm, memory);
    const layout = handles(vm), owner = { engine, vm };
    owners.set(vm, { engine, memory, limit, stackPointer: () => stackPointer(), handles: layout });
    let memoryReplaced = false;
    try {
        assertOwned(owner);
        if (image) {
            if (!sameHandles(layout, image.handles))
                throw new Error('模板检查点句柄与当前引擎不兼容');
            const destination = new Uint8Array(memory.buffer), digest = createHash('sha256');
            // 新模块的静态区、栈和初始 context 已经写过；这些页的 null 必须真正清空。
            // allocator 确认可用末端之后仍是新建 WASM 内存的零区，可跳过重复写零。
            const freshUsedBytes = templateCheckpointMemory(destination)?.segmentEnd ?? destination.length;
            for (let index = 0; index < image.payload.length; index++) {
                const payload = image.payload[index], offset = index * TEMPLATE_CHECKPOINT_PAGE_BYTES;
                if (payload === null) {
                    memoryReplaced = true;
                    if (offset < freshUsedBytes)
                        destination.fill(0, offset, offset + TEMPLATE_CHECKPOINT_PAGE_BYTES);
                    digest.update(ZERO_PAGE);
                    continue;
                }
                const compressed = Buffer.from(payload, 'base64');
                if (compressed.length > TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES || compressed.toString('base64') !== payload)
                    throw new Error('模板检查点 base64 正文无效');
                let bytes;
                try {
                    bytes = gunzipSync(compressed, { maxOutputLength: TEMPLATE_CHECKPOINT_PAGE_BYTES });
                }
                catch {
                    throw new Error('模板检查点解压失败或超限');
                }
                if (bytes.length !== TEMPLATE_CHECKPOINT_PAGE_BYTES)
                    throw new Error('模板检查点解压页长度无效');
                digest.update(bytes);
                memoryReplaced = true;
                destination.set(bytes, offset);
            }
            if (digest.digest('hex') !== image.memoryHash)
                throw new Error('模板检查点内存正文与摘要不一致');
            assertOwned(owner);
        }
        return owner;
    }
    catch (error) {
        // 解压中途失败时不能拿部分替换的 C 堆调用析构；直接交由外层销毁 worker/WASM 实例。
        if (!memoryReplaced)
            vm.dispose();
        throw error;
    }
}
/** 只读取内存与固定 FFI 状态，不调用 variables/schema，也不执行任何第三方脚本。 */
export function dumpTemplateCheckpointVm(owner) {
    const internal = assertOwned(owner), memory = owner.engine.getWasmMemory();
    if (memory.buffer.byteLength > TEMPLATE_CHECKPOINT_MEMORY_MAX_BYTES)
        throw new Error('模板检查点内存超过资源容量');
    const bytes = new Uint8Array(memory.buffer), digest = createHash('sha256'), payload = [];
    const layout = templateCheckpointMemory(bytes), memoryBytes = layout?.memoryBytes ?? bytes.length;
    const ranges = layout?.zeroRanges(), patches = layout?.patches ?? [], scratch = new Uint8Array(TEMPLATE_CHECKPOINT_PAGE_BYTES);
    const scratchView = new DataView(scratch.buffer);
    let range = ranges?.next();
    let compressedBytes = 0, patchIndex = 0;
    for (let offset = 0; offset < memoryBytes; offset += TEMPLATE_CHECKPOINT_PAGE_BYTES) {
        const end = offset + TEMPLATE_CHECKPOINT_PAGE_BYTES;
        let page = bytes.subarray(offset, end), copied = false;
        while (range && !range.done && range.value[0] < end) {
            const [start, stop] = range.value;
            if (stop > offset) {
                if (!copied) {
                    scratch.set(page);
                    page = scratch;
                    copied = true;
                }
                page.fill(0, Math.max(start, offset) - offset, Math.min(stop, end) - offset);
            }
            if (stop <= end)
                range = ranges.next();
            else
                break;
        }
        while (patchIndex < patches.length && patches[patchIndex][0] < end) {
            const [address, value] = patches[patchIndex++];
            if (!copied) {
                scratch.set(page);
                page = scratch;
                copied = true;
            }
            scratchView.setUint32(address - offset, value, true);
        }
        digest.update(page);
        const words = new Uint32Array(page.buffer, page.byteOffset, page.byteLength / 4);
        let zero = true;
        for (const word of words)
            if (word !== 0) {
                zero = false;
                break;
            }
        if (zero) {
            payload.push(null);
            continue;
        }
        const compressed = gzipSync(page, { level: 1 });
        compressedBytes += compressed.length;
        if (compressed.length > TEMPLATE_CHECKPOINT_PAGE_COMPRESSED_MAX_BYTES || compressedBytes > TEMPLATE_CHECKPOINT_COMPRESSED_MAX_BYTES)
            throw new Error('模板检查点压缩正文超过资源容量');
        payload.push(compressed.toString('base64'));
    }
    return { version: 2, engine: TEMPLATE_CHECKPOINT_ENGINE, wasmHash: TEMPLATE_CHECKPOINT_WASM_HASH, memoryBytes, memoryHash: digest.digest('hex'), payload, handles: { ...internal.handles } };
}
