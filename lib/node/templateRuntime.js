/** 模板检查点的受信运行时身份；主线程只读取代码文本和摘要，不创建 VM、不解压检查点、不执行第三方代码。 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveTemplateRuntimeIdentity } from '../core/templateRuntimeAbi.js';
import { BOOTSTRAP } from './templateBootstrap.js';
import { assertTemplateCheckpointEngine } from './templateCheckpointEngine.js';
let runtime;
/** vendor 是受信构建代码；Git 换行转换不能把同一发布产物误判为不兼容版本，执行文本仍原样保留。 */
export function fingerprintTemplateRuntime(bootstrap, librarySource, fakerSource) {
    return createHash('sha256').update(bootstrap).update('\0').update(librarySource.replaceAll('\r\n', '\n'))
        .update('\0').update(fakerSource.replaceAll('\r\n', '\n')).digest('hex');
}
export function loadTemplateRuntime() {
    if (runtime)
        return runtime;
    const pending = Promise.all([
        readFile(new URL('../../lib/vendor/template-libraries.js', import.meta.url), 'utf8'),
        readFile(new URL('../../lib/vendor/template-faker.js', import.meta.url), 'utf8'),
    ]).then(([librarySource, fakerSource]) => ({ librarySource, fakerSource, hash: fingerprintTemplateRuntime(BOOTSTRAP, librarySource, fakerSource) }));
    runtime = pending;
    // 缺失/暂时不可读不是可复用的运行时；修复安装后，同一宿主进程必须允许重新加载。
    void pending.catch(() => { if (runtime === pending)
        runtime = undefined; });
    return pending;
}
export async function assertTemplateCheckpointRuntime(replay) {
    if (replay.checkpoint) {
        resolveTemplateRuntimeIdentity(replay.checkpoint, (await loadTemplateRuntime()).hash);
        await assertTemplateCheckpointEngine();
    }
}
