const OFF_IDS = new Set(['off', 'none', 'disabled']);
function isOffEffort(id) {
    return id !== undefined && OFF_IDS.has(id.toLowerCase());
}
/** 解析不到公布档时仍认它接受 off：部署没锁死 thinking 的话，插件必须关得掉。 */
const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official';
/**
 * 按 Tavern「深度思考」设置挑选 reasoningEffort。
 * disabled → 公布的 off 档（没有则 undefined，调用方不得瞎填）；
 * low/high/max → 模型公布了该档则显式指定，否则回退自动；
 * enabled → 自动：保留会话已选的非 off 档，否则模型默认，否则第一个非 off 档。
 */
export function pickReasoningEffort(thinking, efforts, defaultEffort, current) {
    const ids = efforts?.map((e) => e.id) ?? [];
    const advertised = (id) => ids.length === 0 || ids.includes(id);
    if (thinking === 'disabled') {
        return ids.find((id) => isOffEffort(id));
    }
    if ((thinking === 'low' || thinking === 'high' || thinking === 'max') && ids.includes(thinking))
        return thinking;
    if (current && !isOffEffort(current) && advertised(current))
        return current;
    if (defaultEffort && !isOffEffort(defaultEffort) && advertised(defaultEffort))
        return defaultEffort;
    return ids.find((id) => !isOffEffort(id));
}
/**
 * 三级挑选 reasoningEffort：agent/request 与 impersonate 共用这一处，别再各写一份。
 * ① 模型公布档 → `pickReasoningEffort`；
 * ② 公布档给不出结果、且深度思考关闭的 deepseek-official → `off`（元数据解析失败时也要关得掉）；
 * ③ 其余按「无公布信息」自动挑选（关闭则不瞎填）。
 * 放在 core：本函数只做纯挑选、绝不抛错；llm 服务与可能抛错的模型元数据解析留在各自的 node 调用点，
 * 解析失败就传 `undefined` 的 reasoning 进来。
 */
export function resolveTavernReasoningEffort(thinking, reasoning, current, provider) {
    const picked = pickReasoningEffort(thinking, reasoning?.efforts, reasoning?.defaultEffort, current);
    if (picked !== undefined)
        return picked;
    if (thinking === 'disabled' && provider === DEEPSEEK_OFFICIAL_PROVIDER)
        return 'off';
    return pickReasoningEffort(thinking, undefined, undefined, current);
}
/** 透传 temperature / maxTokens / stop，并在有合法档位时写入 reasoningEffort。 */
export function mergeTavernCallConfig(config, sampling, reasoningEffort) {
    return {
        ...config,
        temperature: sampling.temperature,
        ...(sampling.maxTokens !== null ? { maxTokens: sampling.maxTokens } : {}),
        ...(sampling.stop.length > 0 ? { stop: [...sampling.stop] } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
}
