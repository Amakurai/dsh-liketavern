/** 捕获宿主原生分支请求的确切来源，在宿主创建子会话之前持久化插件侧来源凭据。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isTavernPresetId } from '../core/tavernMode.js';
import { guardPhase } from './hostCompat.js';
import { writeHostForkIdentity } from './hostForkIdentity.js';
import { forkedSessionParents } from './sessionArchiveSnapshot.js';
import { isTavernRuntimeSession } from './tavernSession.js';
import { SessionId } from '@deepseek-ai/dsh-session';
/** 只包装当前服务实例；并发分支各用独立异步上下文，来源仅记录在插件状态中。 */
export function captureHostForkRequests(controller, agents, sourceIsTavern, saveIdentity) {
    const context = new AsyncLocalStorage();
    const originalFork = controller.fork, originalCreate = agents.create;
    const create = function (options) {
        const capture = context.getStore();
        if (!capture?.active || capture.used || !options || typeof options !== 'object' || Array.isArray(options)) {
            return Reflect.apply(originalCreate, this, [options]);
        }
        const input = options;
        const meta = input.meta;
        if (!meta || typeof meta !== 'object' || Array.isArray(meta))
            return Reflect.apply(originalCreate, this, [options]);
        const fields = meta;
        const count = input.inheritedEventCount;
        const preset = typeof fields.agentPreset === 'string' ? fields.agentPreset : undefined;
        if (fields.isSeeded !== true || !Array.isArray(input.seed) || !Number.isSafeInteger(count) || count <= 0
            || count > input.seed.length || typeof input.sessionId !== 'string' || !input.sessionId
            || (capture.atSeq !== undefined && count !== capture.atSeq + 1)
            || !(preset === undefined ? sourceIsTavern(capture.parentId) : isTavernPresetId(preset))) {
            return Reflect.apply(originalCreate, this, [options]);
        }
        if (fields.parentSession !== undefined && fields.parentSession !== capture.parentId) {
            throw new Error('宿主分支请求与子会话的来源身份不一致');
        }
        capture.used = true;
        // 旧宿主已持久化正确父身份；保留它自己的创建时序，不增加额外写入。
        if (fields.parentSession === capture.parentId)
            return Reflect.apply(originalCreate, this, [options]);
        const childId = input.sessionId, prefix = input.seed.slice(0, count);
        return saveIdentity(childId, capture.parentId, prefix).then(() => {
            forkedSessionParents.set(childId, SessionId(capture.parentId));
            return Reflect.apply(originalCreate, this, [options]);
        });
    };
    const fork = function (request) {
        if (!request || typeof request !== 'object' || Array.isArray(request))
            return Reflect.apply(originalFork, this, [request]);
        const input = request;
        if (typeof input.sessionId !== 'string' || !input.sessionId)
            return Reflect.apply(originalFork, this, [request]);
        const atSeq = typeof input.atSeq === 'number' && Number.isSafeInteger(input.atSeq) && input.atSeq >= 0 ? input.atSeq : undefined;
        const capture = { parentId: input.sessionId, atSeq, active: true, used: false };
        return context.run(capture, async () => {
            try {
                return await Reflect.apply(originalFork, this, [request]);
            }
            finally {
                capture.active = false;
            }
        });
    };
    try {
        agents.create = create;
        controller.fork = fork;
    }
    catch (error) {
        if (agents.create === create)
            agents.create = originalCreate;
        throw error;
    }
    return () => {
        if (agents.create === create)
            agents.create = originalCreate;
        if (controller.fork === fork)
            controller.fork = originalFork;
        context.disable();
    };
}
/** sessionController 可晚于插件出现或替换；注入子作用域负责安装与卸载。 */
export function installHostForkCapture(ctx, paths) {
    void ctx.inject(['sessionController', 'agents'], scope => {
        guardPhase(scope, '宿主分支身份追踪', () => {
            const controller = scope.get('sessionController');
            const agents = scope.get('agents');
            if (typeof controller?.fork !== 'function' || typeof agents?.create !== 'function') {
                throw new Error('缺少宿主分支或会话创建接口，无法确认来源的分支将被拒绝');
            }
            scope.effect(() => captureHostForkRequests(controller, agents, id => {
                try {
                    const sessions = scope.get('sessions');
                    const session = sessions?.get(id);
                    return session ? isTavernRuntimeSession(scope, session) : false;
                }
                catch {
                    return false;
                }
            }, (childId, parentId, prefix) => writeHostForkIdentity(paths, childId, parentId, prefix)), 'dsh-tavern host fork capture');
        });
    });
}
