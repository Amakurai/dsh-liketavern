import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from './presetAdapter.js';
const present = (value) => typeof value === 'string' && value.trim() !== '';
export function sessionModelRoute(agent) {
    // 请求头与 options 各自成对取用，不能拼出「新 provider + 旧 model」这类不存在的组合。
    const logged = agent.session?.requestHeader?.()?.config;
    const fromLog = present(logged?.provider) && present(logged?.model);
    const provider = fromLog ? logged.provider : agent.options.provider;
    const model = fromLog ? logged.model : agent.options.model;
    return {
        ...(present(provider) ? { provider: provider === PRESET_ADAPTER_PROVIDER ? PRESET_ADAPTER_SOURCE_PROVIDER : provider } : {}),
        ...(present(model) ? { model } : {}),
    };
}
