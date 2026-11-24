import { hasNativeMvuEntry } from '../core/cardScript.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
import { runHelperMvuEnable } from './helperMvuLifecycle.js';
import { sessionHelperLibraries } from './helperRuntime.js';
export async function enableHelperMvu(ctx, state, request) {
    const check = async (waitForAdoption) => {
        const binding = await state.loadStoryBinding(request.sessionId, { waitForAdoption });
        if (!binding?.storyId || binding.storyId !== request.storyId)
            throw new Error('会话剧情绑定已改变，请刷新后重试');
        if (binding.helperMvu === true)
            return { kind: 'on' };
        if (!state.config.interactiveCards || binding.interactiveCards === false) {
            if (request.mode === 'explicit')
                throw new Error('交互卡已关闭，不能开启原生 MVU');
            return { kind: 'skip' };
        }
        if (request.mode === 'follow' && (binding.helperMvu === false || !hasNativeMvuEntry(await sessionHelperLibraries(state, binding))))
            return { kind: 'skip' };
        return { kind: 'enable', binding };
    };
    const outcome = (verdict) => ({ enabled: verdict.kind === 'on', changed: false });
    const first = await check(true);
    if (first.kind !== 'enable')
        return outcome(first);
    return runHelperMvuEnable(ctx, state, request.sessionId, async () => {
        await state.waitForBindingAdoption(request.sessionId);
        return withWorkspaceLock(state.paths.sessions, async () => {
            // 等待 idle 期间用户可能已换卡、关闭或另一页面已开启；以锁内复核为准，且锁内不再反向等接管。
            const current = await check(false);
            if (current.kind !== 'enable')
                return outcome(current);
            await state.saveBinding({ ...current.binding, helperMvu: true });
            return { enabled: true, changed: true };
        });
    });
}
