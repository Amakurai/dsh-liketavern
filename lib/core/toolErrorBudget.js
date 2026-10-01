/** 工具业务拒绝的完整 JSON 展示预算：短错误保留契约，超限只裁错误展示并显式标记，不改输入或伪造定位字段。 */
import { ASSET_OUTPUT_TOKEN_BUDGET, assetOutputTokens, clipAssetJsonText, stampAssetTokens } from './assetRead.js';
export function boundedToolError(error) {
    const full = { ok: false, error };
    if (assetOutputTokens(full) <= ASSET_OUTPUT_TOKEN_BUDGET)
        return full;
    const clipped = { ok: false, error: '', errorTruncated: true, tokensUsed: 0 };
    clipped.error = clipAssetJsonText(error, ASSET_OUTPUT_TOKEN_BUDGET - assetOutputTokens(clipped) - 16).text;
    return stampAssetTokens(clipped);
}
