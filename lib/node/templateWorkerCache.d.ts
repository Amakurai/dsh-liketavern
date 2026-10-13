import type { TemplateContext } from '../core/template.js';
import type { TemplateReplay } from '../core/templateReplay.js';
import type { TemplateSandbox } from './templateSandbox.js';
export declare function templateWorkerCacheKey(replay: TemplateReplay | undefined, context: TemplateContext | undefined): string | undefined;
export declare class TemplateWorkerCache {
    private current?;
    get key(): string | undefined;
    take(key: string | undefined, replay: TemplateReplay, resourceChars: number): TemplateSandbox | undefined;
    keep(sandbox: TemplateSandbox, replay: TemplateReplay, context: TemplateContext): string;
    clear(): void;
}
