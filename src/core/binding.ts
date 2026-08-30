/**
 * 会话绑定的纯函数：角色卡删除后，用名字或「库里只剩一张卡」把陈旧 cardId 接回新工作区。
 * 文件夹 ID（净化名 + hash）不能当展示名，回收失败则视为未绑定。
 */

export interface BindingCardRef {
  cardId: string
  name: string
}

/** 绑定里可选的展示名，旧文件没有该字段。 */
export interface StaleBindingRef {
  cardId: string
  cardName?: string
}

/**
 * 若 binding.cardId 仍在角色列表中则原样返回；否则按 cardName 或唯一剩余角色改写 cardId。
 * 无法回收时返回 null（调用方应丢掉绑定文件，避免 UI 把文件夹 ID 当成角色名）。
 */
export function resolveStaleBinding<T extends StaleBindingRef>(binding: T, characters: BindingCardRef[]): T | null {
  if (characters.some((c) => c.cardId === binding.cardId)) {
    const live = characters.find((c) => c.cardId === binding.cardId)
    if (live && binding.cardName !== live.name) return { ...binding, cardName: live.name }
    return binding
  }
  // 按名接回只允许唯一命中：库里有多张同名卡时 find 会静默接错（工作区/记忆/WAL 都按 cardId）。
  const byName = binding.cardName ? characters.filter((c) => c.name === binding.cardName) : []
  if (byName.length === 1) return { ...binding, cardId: byName[0]!.cardId, cardName: byName[0]!.name }
  if (characters.length === 1) {
    const only = characters[0]!
    return { ...binding, cardId: only.cardId, cardName: only.name }
  }
  return null
}
