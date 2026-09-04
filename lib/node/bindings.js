/**
 * 会话绑定：Tavern 会话 ↔ 角色卡/预设/人设/世界书选择。
 * 存 `sessions/<sessionId>.json`（host 数据目录；不随楼层回滚——绑定不是剧情状态）。
 * SessionBinding / WalLineageEntry 是纯数据形状，定义在 core/binding（remote 契约引用），此处 re-export。
 */
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionFile } from './paths.js';
export async function loadBinding(paths, sessionId) {
    try {
        const raw = await readFile(sessionFile(paths, sessionId), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.sessionId !== sessionId || typeof parsed.cardId !== 'string')
            return null;
        return parsed;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        return null; // 绑定文件损坏视为未绑定（面板可重选）
    }
}
export async function saveBinding(paths, binding) {
    await writeFile(sessionFile(paths, binding.sessionId), JSON.stringify(binding, null, 2) + '\n', 'utf8');
}
export async function deleteBinding(paths, sessionId) {
    try {
        await unlink(sessionFile(paths, sessionId));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
/** 删除角色卡时清掉仍指向该 cardId 的会话绑定，避免封面页继续显示文件夹 ID。 */
export async function clearBindingsForCard(paths, cardId) {
    let files = [];
    try {
        files = await readdir(paths.sessions);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
    await Promise.all(files.map(async (file) => {
        if (!file.endsWith('.json'))
            return;
        const abs = join(paths.sessions, file);
        try {
            const parsed = JSON.parse(await readFile(abs, 'utf8'));
            if (parsed.cardId === cardId)
                await unlink(abs);
        }
        catch {
            // 坏文件跳过
        }
    }));
}
