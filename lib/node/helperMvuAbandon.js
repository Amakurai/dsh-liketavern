import { createHash } from 'node:crypto';
import { parseHelperMvuState } from '../core/helperMvu.js';
import { helperRecord } from '../core/helperRuntime.js';
import { loadHelperState, saveHelperState } from '../state/helper.js';
import { loadTemplateState } from '../state/template.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
import { revokeHelperMvuLease } from './helperMvu.js';
export const HELPER_MVU_ABANDON_PATH = 'state/helper-mvu-abandon.json';
const digest = (saved) => createHash('sha256').update(JSON.stringify(saved)).digest('hex');
function parseRecovery(raw) {
    if (raw === null)
        return null;
    if (raw.length > 2048)
        throw new Error('自动 MVU 放弃恢复记录超限');
    const value = JSON.parse(raw);
    if (!helperRecord(value) || value.version !== 1 || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 256
        || typeof value.storyId !== 'string' || !value.storyId || value.storyId.length > 256 || typeof value.floor !== 'string' || !value.floor || value.floor.length > 320
        || typeof value.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultDigest)
        || Object.keys(value).some(key => !['version', 'sessionId', 'storyId', 'floor', 'resultDigest'].includes(key)))
        throw new Error('自动 MVU 放弃恢复记录损坏');
    return value;
}
/** 复用分支回滚的顺序：先按 turn，再按祖先到当前会话排序，同轮选择当前分支。 */
function orderOf(floor, binding) {
    const match = /^(.*)#t([0-9]+)$/.exec(floor);
    if (!match || !Number.isSafeInteger(Number(match[2])))
        return null;
    const turn = Number(match[2]), lineage = binding.walLineage ?? [];
    if (match[1] === binding.sessionId)
        return { turn, owner: lineage.length };
    const owner = lineage.findIndex(item => item.sessionId === match[1] && item.throughTurn >= turn);
    return owner < 0 ? null : { turn, owner };
}
export async function abandonHelperMvu(state, request) {
    if (!request.sessionId || request.sessionId.length > 256 || !request.storyId || request.storyId.length > 256)
        throw new Error('自动 MVU 剧情身份无效');
    const first = await state.loadBinding(request.sessionId);
    if (!first?.storyId || first.storyId !== request.storyId)
        throw new Error('自动 MVU 剧情绑定已改变');
    const workspace = await state.storyWorkspace(first.cardId, first.storyId);
    return withWorkspaceLock(workspace.fs.root, () => withWorkspaceLock(state.paths.sessions, async () => {
        const binding = await state.loadBinding(request.sessionId);
        if (!binding || binding.cardId !== first.cardId || binding.storyId !== request.storyId)
            throw new Error('自动 MVU 剧情绑定已改变');
        const saved = await loadHelperState(workspace.fs), mvu = parseHelperMvuState(saved.mvu);
        const open = state.openFloors.get(request.sessionId);
        const generation = (await loadTemplateState(workspace.fs)).generation;
        if (generation?.status === 'prepared' && !(open?.floor === generation.floor && open.cardId === generation.cardId && open.storyId === generation.storyId && generation.sessionId === request.sessionId))
            throw new Error('模板楼层尚未收口，请先恢复宿主生成；不能通过放弃 MVU 绕过');
        const recovery = parseRecovery(await workspace.fs.readText(HELPER_MVU_ABANDON_PATH));
        const floors = await workspace.wal.listFloors();
        if (floors.length > 4096)
            throw new Error('自动 MVU 恢复楼层数量超过预算');
        const owned = floors.filter(item => !item.rolledBack).flatMap(item => {
            const order = orderOf(item.floor, binding);
            return order ? [{ ...item, ...order }] : [];
        }).sort((a, b) => a.turn - b.turn || a.owner - b.owner);
        // 不能用新楼层的清队列操作绕过旧任务、完成回执或所属历史中的损坏 WAL。
        for (const floor of owned)
            await workspace.wal.validateFloor(floor.floor);
        const known = new Set(owned.map(item => item.floor));
        for (const job of mvu.pending)
            if (!known.has(job.floor))
                throw new Error('自动 MVU 待处理任务的所属 WAL 缺失或已回滚');
        if (open && (open.cardId !== binding.cardId || open.storyId !== binding.storyId || open.floor !== owned.at(-1)?.floor))
            throw new Error('自动 MVU 当前楼层与剧情恢复目标不一致');
        const receipt = mvu.completed.at(-1);
        if (receipt) {
            if (!known.has(receipt.floor))
                throw new Error('自动 MVU 完成回执的所属 WAL 缺失或已回滚');
            const floor = await workspace.wal.validateFloor(receipt.floor);
            if (!floor.committed && open?.floor !== receipt.floor)
                await workspace.wal.commitFloor(receipt.floor);
        }
        const target = owned.at(-1)?.floor;
        if (mvu.pending.length && !target)
            throw new Error('自动 MVU 没有可写入的所属 WAL 楼层');
        const recovering = recovery && known.has(recovery.floor) ? await workspace.wal.validateFloor(recovery.floor) : null;
        if (recovery && !recovering)
            throw new Error('自动 MVU 放弃恢复记录的 WAL 缺失或已回滚');
        if (recovering && !recovering.committed && open?.floor !== recovering.floor) {
            if (recovery.sessionId !== request.sessionId || recovery.storyId !== request.storyId)
                throw new Error('自动 MVU 放弃恢复记录属于其它剧情');
            if (!mvu.pending.length || recovering.floor !== target) {
                if (digest(saved) !== recovery.resultDigest)
                    throw new Error('自动 MVU 放弃恢复记录与当前变量不一致，不能标记已完成');
                await workspace.wal.commitFloor(recovering.floor);
            }
        }
        const targetInfo = owned.at(-1);
        if (mvu.pending.length && targetInfo && !targetInfo.committed && !open && target !== receipt?.floor && !mvu.pending.some(job => job.floor === target)
            && !(recovery !== null && recovery.floor === target && recovery.sessionId === request.sessionId && recovery.storyId === request.storyId))
            throw new Error('最新楼层存在未收口的宿主事务，不能通过放弃 MVU 提交');
        // 先暂停运行。其后的故障保留明确的关闭状态，可重复点击恢复，旧沙箱也无法再提交。
        await state.saveBinding({ ...binding, helperMvu: false });
        revokeHelperMvuLease(state, request.sessionId, request.storyId);
        try {
            if (mvu.pending.length && target) {
                const next = { ...saved, mvu: { ...mvu, pending: [] } };
                // 专属标记先经原楼层 WAL 保存，再重新打开元数据；失败重试不会把其它宿主事务误判为本操作。
                await workspace.fs.withFloor(target).writeText(HELPER_MVU_ABANDON_PATH, JSON.stringify({ version: 1, ...request, floor: target, resultDigest: digest(next) }));
                await workspace.wal.reopenFloor(target);
                await saveHelperState(workspace.fs.withFloor(target), next);
                if (!open)
                    await workspace.wal.commitFloor(target);
            }
        }
        catch (cause) {
            throw new Error('自动 MVU 已关闭，但放弃任务尚未完成；已保存变量保留，请重试：' + String(cause instanceof Error ? cause.message : cause), { cause });
        }
        return { disabled: true, abandoned: mvu.pending.length };
    }));
}
