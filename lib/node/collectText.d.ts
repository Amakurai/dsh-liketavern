/** 辅助模型调用的完整性边界：只接受 stop 终止帧；超时/截断/错误均不得提交半截正文。 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
export declare function collectCompleteText(stream: AsyncIterable<StreamChunk>, signal: AbortSignal): Promise<string>;
