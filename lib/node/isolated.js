/** 第三方正则/WI/提示词在有内存和时间上限的 worker 内执行；主线程只做 I/O 和编排。 */
import { Worker } from 'node:worker_threads';
let active = 0;
const waiting = [];
const MAX_INPUT_CHARS = 16 * 1024 * 1024;
export async function isolated(kind, input, timeoutMs = 1000) {
    if (JSON.stringify(input).length > MAX_INPUT_CHARS)
        throw new Error('提示词计算输入超过 16 MiB 上限');
    if (active >= 2) {
        if (waiting.length >= 16)
            throw new Error('提示词计算队列已满，请稍后重试');
        await new Promise((resolve) => waiting.push(resolve));
    }
    else
        active++;
    try {
        const sourceMode = import.meta.url.endsWith('.ts');
        const entry = new URL(sourceMode ? './computeWorker.ts' : './computeWorker.js', import.meta.url).href;
        // 源码测试用 Node 24 的类型剥离，仅将本源码树内的相对 .js 导入映射到 .ts。
        // 交付运行只加载 tsc 产物，不安装 loader，不依赖测试构建或本机路径。
        const bootstrap = sourceMode ? `
      const { registerHooks } = require('node:module');
      const { workerData } = require('node:worker_threads');
      registerHooks({ resolve(specifier, context, next) {
        if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(workerData.sourceRoot)) {
          return next(specifier.slice(0, -3) + '.ts', context);
        }
        return next(specifier, context);
      }});
      import(workerData.entry);
    ` : `import(require('node:worker_threads').workerData.entry);`;
        return await new Promise((resolve, reject) => {
            const worker = new Worker(bootstrap, { eval: true,
                workerData: { entry, sourceRoot: new URL('../', import.meta.url).href, kind, input },
                resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
            });
            let settled = false;
            const finish = (error, value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                void worker.terminate().then(() => error ? reject(error) : resolve(value), reject);
            };
            let timer = setTimeout(() => finish(new Error('提示词 worker 启动超时')), 10_000);
            worker.on('message', (message) => {
                if (message.ready) {
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(new Error('第三方正则或提示词计算超时，已终止 worker')), timeoutMs);
                }
                else if (message.error)
                    finish(new Error(message.error));
                else
                    finish(undefined, message.value);
            });
            worker.on('error', (error) => finish(error));
            worker.on('exit', (code) => { if (!settled)
                finish(new Error(`提示词 worker 提前退出：${code}`)); });
        });
    }
    finally {
        const next = waiting.shift();
        if (next)
            next();
        else
            active--;
    }
}
