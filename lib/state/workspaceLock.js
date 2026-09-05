/** 工作区级进程内互斥：楼层、面板、归并和回滚共享；嵌套文件操作可重入。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
const tails = new Map();
const owners = new AsyncLocalStorage();
export function withWorkspaceLock(root, task) {
    const absolute = resolve(root);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const held = owners.getStore();
    if (held?.has(key))
        return task();
    const run = (tails.get(key) ?? Promise.resolve()).then(() => owners.run(new Set([...(held ?? []), key]), task));
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail)
        tails.delete(key); });
    return run;
}
