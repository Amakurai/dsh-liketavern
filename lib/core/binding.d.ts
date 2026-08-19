/**
 * 会话绑定的纯函数：角色卡删除后，用名字或「库里只剩一张卡」把陈旧 cardId 接回新工作区。
 * 文件夹 ID（净化名 + hash）不能当展示名，回收失败则视为未绑定。
 */
export interface BindingCardRef {
    cardId: string;
    name: string;
}
/** 绑定里可选的展示名，旧文件没有该字段。 */
export interface StaleBindingRef {
    cardId: string;
    cardName?: string;
}
/**
 * 若 binding.cardId 仍在角色列表中则原样返回；否则按 cardName 或唯一剩余角色改写 cardId。
 * 无法回收时返回 null（调用方应丢掉绑定文件，避免 UI 把文件夹 ID 当成角色名）。
 */
export declare function resolveStaleBinding<T extends StaleBindingRef>(binding: T, characters: BindingCardRef[]): T | null;
