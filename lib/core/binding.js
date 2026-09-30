/**
 * 会话绑定的纯函数：角色卡删除后，用名字或「库里只剩一张卡」把陈旧 cardId 接回新工作区。
 * 文件夹 ID（净化名 + hash）不能当展示名，回收失败则视为未绑定。
 * SessionBinding 数据形状也归这里（纯数据，core 层）；持久化在 node/bindings，remote 契约引用本文件。
 */
/**
 * {{pick}} 的聊天身份（对齐 ST 的 chat id hash）：取分支世系的根会话。重新生成、编辑与分支都会
 * 建子会话，但世系根不变，已抽定的设定不会随之改变；无世系的会话即自身。
 */
export function chatPickSeed(binding) {
    return binding.walLineage?.[0]?.sessionId ?? binding.sessionId;
}
/**
 * 若 binding.cardId 仍在角色列表中则原样返回；否则按 cardName 或唯一剩余角色改写 cardId。
 * 无法回收时返回 null（调用方应丢掉绑定文件，避免 UI 把文件夹 ID 当成角色名）。
 */
export function resolveStaleBinding(binding, characters) {
    if (characters.some((c) => c.cardId === binding.cardId)) {
        const live = characters.find((c) => c.cardId === binding.cardId);
        if (live && binding.cardName !== live.name)
            return { ...binding, cardName: live.name };
        return binding;
    }
    // 按名接回只允许唯一命中：库里有多张同名卡时 find 会静默接错（工作区/记忆/WAL 都按 cardId）。
    const byName = binding.cardName ? characters.filter((c) => c.name === binding.cardName) : [];
    if (byName.length === 1)
        return { ...binding, cardId: byName[0].cardId, cardName: byName[0].name };
    if (characters.length === 1) {
        const only = characters[0];
        return { ...binding, cardId: only.cardId, cardName: only.name };
    }
    return null;
}
