/**
 * DSH Agent 模块兼容层：在测试环境提供 2 参数版 installModelSelection 向后兼容 polyfill。
 * 生产环境运行于宿主 DSH 0.2.2-rc.1 原生单参数 installModelSelection(agentCtx)。
 */
import * as upstreamAgent from '@deepseek-ai/dsh-agent';
export * from '@deepseek-ai/dsh-agent';
export function installModelSelection(agentCtx, legacySelection) {
    if (legacySelection && typeof legacySelection === 'object') {
        agentCtx.on('agent/pre-step', async ({ agent, modelSelection }, next) => {
            if (legacySelection.current && agent?.model) {
                const cur = legacySelection.current;
                if (cur.provider && cur.model) {
                    agent.model.select(cur);
                    if (modelSelection) {
                        modelSelection.provider = cur.provider;
                        modelSelection.model = cur.model;
                        if (cur.reasoningEffort !== undefined)
                            modelSelection.reasoningEffort = cur.reasoningEffort;
                    }
                }
            }
            return next();
        }, { prepend: true });
        agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
            const res = await next();
            if (legacySelection.current?.provider) {
                res.variables['provider'] = legacySelection.current.provider;
            }
            return res;
        });
        agentCtx.on('agent/request', async (_payload, next) => {
            const config = await next();
            if (legacySelection.current?.provider && legacySelection.current?.model) {
                return {
                    ...config,
                    provider: legacySelection.current.provider,
                    model: legacySelection.current.model,
                    ...(legacySelection.current.reasoningEffort === undefined ? {} : { reasoningEffort: legacySelection.current.reasoningEffort }),
                };
            }
            return config;
        });
    }
    return upstreamAgent.installModelSelection(agentCtx);
}
