import { helperJson, helperRecord } from '../core/helperRuntime.js';
import { helperHistoryOf } from './helperRuntime.js';
export function currentHelperMvuTemplateData(events, scopes) {
    // 轮初尚无本轮目标 assistant；与 prepareHelperMvuJob 在目标之前倒序找 scope 一致，
    // 包括手动保存的用户消息变量。原生回执 lastIdentity 不能覆盖之后的新 scope。
    const history = helperHistoryOf(events, { char: '', user: '' });
    for (let index = history.length - 1; index >= 0; index--) {
        const item = history[index], data = scopes[JSON.stringify(['message', item.identity])];
        if (!helperRecord(data?.stat_data))
            continue;
        return helperJson(data.stat_data);
    }
    return undefined;
}
