/** 从当前角色和当前人设的固定头像文件生成冻结 URL；不采信资产 JSON 中的任意路径或远程地址。 */
import { Buffer } from 'node:buffer';
import { templateAvatarPng } from '../core/templateAvatar.js';
import { WorkspaceFs } from '../state/workspaceFs.js';
async function readAvatar(fs, file) {
    const info = await fs.stat(file);
    if (!info || info.size > 32 * 1024 * 1024)
        return '';
    const raw = await fs.readBytes(file);
    const png = raw && templateAvatarPng(raw);
    return png ? `data:image/png;base64,${Buffer.from(png).toString('base64')}` : '';
}
export async function loadTemplateAvatars(state, cardId, persona) {
    const character = await state.workspace(cardId);
    const charAvatar = await readAvatar(character.fs, 'card.png');
    // Persona 的契约是 personas/<id>.png；头像字段不能扩大到其他人设、卡片或剧情文件。
    const validPersona = persona && typeof persona.id === 'string' && /^[\p{L}\p{N}_.-]+$/u.test(persona.id)
        && !persona.id.includes('..') && persona.avatar === `${persona.id}.png`;
    const userAvatar = validPersona ? await readAvatar(new WorkspaceFs(state.paths.personas, null), `${persona.id}.png`) : '';
    return { charAvatar, userAvatar };
}
