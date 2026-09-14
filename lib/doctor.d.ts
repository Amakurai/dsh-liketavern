#!/usr/bin/env node
export type DoctorSeverity = 'info' | 'warning' | 'error';
export type DoctorDirectoryStatus = 'missing' | 'directory' | 'file' | 'link' | 'unreadable';
export interface DoctorIssue {
    code: string;
    severity: DoctorSeverity;
    count: number;
}
export interface DoctorReport {
    schemaVersion: 1;
    ok: boolean;
    runtime: {
        nodeVersion: string;
        requiredNodeMajor: number;
        nodeSupported: boolean;
        pluginVersion: string;
        dsh: {
            installedVersion: string;
            expectedVersion: string;
            compatible: boolean;
        };
    };
    storage: {
        home: '~/.dsh' | '$DSH_HOME';
        dataRoot: '~/.dsh/dsh-tavern' | '$DSH_HOME/dsh-tavern';
        homeStatus: DoctorDirectoryStatus;
        dataRootStatus: DoctorDirectoryStatus;
        directories: {
            characters: DoctorDirectoryStatus;
            lorebooks: DoctorDirectoryStatus;
            presets: DoctorDirectoryStatus;
            personas: DoctorDirectoryStatus;
            regex: DoctorDirectoryStatus;
            sessions: DoctorDirectoryStatus;
        };
    };
    statistics: {
        files: {
            total: number;
            json: number;
            invalidJson: number;
            oversizedJson: number;
            unreadable: number;
            skippedLinks: number;
            scanTruncated: boolean;
        };
        characters: {
            directories: number;
            healthy: number;
            unhealthy: number;
            uninspected: number;
            archived: number;
            invalidIds: number;
            unsafeEntries: number;
        };
        stories: {
            directories: number;
            healthy: number;
            unhealthy: number;
            uninspected: number;
            drafts: number;
            unsafeEntries: number;
        };
        wal: {
            roots: number;
            floors: number;
            active: number;
            rolledBack: number;
            healthy: number;
            unhealthy: number;
            uninspected: number;
            committed: number;
            pending: number;
            unsafeEntries: number;
        };
    };
    issues: DoctorIssue[];
}
export interface RunDoctorOptions {
    /** 测试或显式 CLI 覆盖使用；该绝对值从不进入报告。 */
    home?: string;
    env?: Record<string, string | undefined>;
    nodeVersion?: string;
    pluginVersion?: string;
    /** 测试注入；非法值会折叠为 unknown，绝不原样输出。 */
    dshInstalledVersion?: string;
    dshExpectedVersion?: string;
    /** 仅允许缩小默认累计预算，供边界测试与受限环境使用。 */
    readBudgetBytes?: number;
    /** 结构检查与普通文件遍历共用目录项预算；只能缩小默认上限。 */
    scanEntryLimit?: number;
}
export declare function areDshVersionsCompatible(installedVersion: string, expectedVersion: string): boolean;
/** 执行一次无副作用诊断；即使目录损坏，返回值也只包含固定字段、状态枚举与计数。 */
export declare function runDoctor(options?: RunDoctorOptions): Promise<DoctorReport>;
export declare function formatDoctorText(report: DoctorReport): string;
interface CliArguments {
    json: boolean;
    help: boolean;
    version: boolean;
    home?: string;
}
export declare function parseDoctorArguments(args: string[]): CliArguments;
/** CLI 只返回 0（健康）、1（发现错误）或 2（参数/运行失败），失败详情不回显私人路径。 */
export declare function doctorMain(args?: string[], io?: {
    out: (text: string) => void;
    err: (text: string) => void;
}): Promise<number>;
export {};
