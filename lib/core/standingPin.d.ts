/**
 * 会话级 standing 钉死：同一绑定指纹下复用第一次写入 system 的字节。
 * DeepSeek 前缀缓存从第 0 个 token 精确匹配；组装管线哪怕只抖一个空格都会变成 0%。
 *
 * 纪律文案 / 段布局变更时递增 STANDING_PIN_VERSION，否则进程内旧钉死会挡住新 standing。
 * 指纹第三段是资产修订号（`key=rev`）：编辑/删除预设与世界书经 TavernState 写方法 bump，
 * 下一轮指纹变化即重算 standing 并重新钉死——内容变更打穿一次 KV 是必要代价，
 * 平时仍字节稳定。运行期绕开 TavernState 手改文件不捕获（pins 进程内，重启即清）。
 * 同一段还带一个 `config=<hash>` 标记（见 TavernState.standingRevTags）：设置里只有少数几项
 * 会改变 standing 字节，改了必须立刻失效，否则设置改动整个进程生命周期都到不了模型。
 *
 * 钉死粒度 = 会话 × 生成场景（standingPinKey）：injection_trigger 过滤使 normal / continue
 * 骨架可能不同，场景并入指纹且各自占一个钉位——同一会话内场景交替时各自复用本场景首次
 * 钉死的字节，既不互相覆盖重算，也不会让 continue 轮拿到 normal 轮钉死的文本。
 */
export declare const STANDING_PIN_VERSION = 6;
/** 场景值归一化：空/缺省视为 normal（与 assemble.ts 的 generationType 缺省一致）。 */
export declare function normalizeGenerationType(generationType?: string): string;
/** 钉死键：会话 × 生成场景。 */
export declare function standingPinKey(sessionId: string, generationType?: string): string;
export declare function standingFingerprint(binding: {
    cardId: string;
    presetId: string | null;
    personaId: string | null;
}, persona?: {
    name?: string;
    description?: string;
}, 
/** 资产修订号标记（如 `preset:foo=2`），调用方按稳定顺序给出。 */
revs?: readonly string[], 
/** ST 生成场景；改变序列内容（injection_trigger），必须并入指纹。 */
generationType?: string): string;
export interface StandingPin {
    fingerprint: string;
    text: string;
}
/**
 * djb2（无符号 32 位）→ 8 位十六进制。用来把「会改变 standing 字节的设置项」压成一个短标记
 * 并入指纹，不作安全用途；纯函数、无 I/O，调用方自己挑要哪些键。
 */
export declare function stableFingerprintHash(value: unknown): string;
/** 指纹未变则返回已钉死的文本；换卡/换预设/换人设才接受新计算结果。 */
export declare function pinStandingText(pins: Map<string, StandingPin>, sessionId: string, fingerprint: string, computed: string): string;
