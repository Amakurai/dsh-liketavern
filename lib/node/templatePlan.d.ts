import type { ComputeJobs } from './computeWorker.js';
import type { TemplateSandbox } from './templateSandbox.js';
export declare function assembleTemplatePlan(input: ComputeJobs['assemble']['input'], sandbox: TemplateSandbox | null): ComputeJobs['assemble']['output'];
