import type { CharacterCard } from './types.js';
export declare const CHARACTER_COMPATIBILITY_CODES: readonly ["cardFields", "regex", "templates", "html", "scripts", "invalidScripts", "nativeMvu", "customMvu", "unsupportedApi", "parentAccess", "network", "externalScript", "externalMedia", "vectorLore", "scanLimit"];
export type CharacterCompatibilityCode = typeof CHARACTER_COMPATIBILITY_CODES[number];
export type CharacterCompatibilityStatus = 'supported' | 'unsupported' | 'review';
export interface CharacterCompatibilityFinding {
    code: CharacterCompatibilityCode;
    status: CharacterCompatibilityStatus;
    /** 同类信号所在字段/条目数；位置只列有限样本，不传输第三方代码。 */
    count: number;
    locations: string[];
}
export interface CharacterCompatibilityReport {
    version: 1;
    /** 仅表示静态遍历未碰预算上限，不表示兼容、已执行验证或已检查远端依赖。 */
    complete: boolean;
    scannedChars: number;
    findings: CharacterCompatibilityFinding[];
}
export declare function inspectCharacterCompatibility(card: CharacterCard): CharacterCompatibilityReport;
