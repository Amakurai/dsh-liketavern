/** 卡面、后台脚本和预览共用变量工具文案，新增编辑器状态在中英文界面保持一致。 */
import type { CardVariableLabels } from '../core/cardVariables.js';
export declare function cardVariableLabels(t: (key: string) => string, note: string): Required<CardVariableLabels>;
