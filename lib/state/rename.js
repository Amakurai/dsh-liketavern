/** Windows 文件占用的有界替换：仅重试忙/访问拒绝错误，始终使用原路径，不删除目标或退回非原子复制。 */
import { rename } from 'node:fs/promises';
import { platform } from 'node:process';
import { setTimeout } from 'node:timers/promises';
const WINDOWS_DELAYS_MS = [10, 30, 60];
const WINDOWS_BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** 首次成功无延迟；最多额外等待 100 ms，持续拒绝及其它错误仍交还原调用方处理。 */
export async function renameWithRetry(from, to) {
    for (let attempt = 0;; attempt++) {
        try {
            await rename(from, to);
            return;
        }
        catch (error) {
            const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
            const delay = WINDOWS_DELAYS_MS[attempt];
            if (platform !== 'win32' || delay === undefined || typeof code !== 'string' || !WINDOWS_BUSY_CODES.has(code))
                throw error;
            await setTimeout(delay);
        }
    }
}
