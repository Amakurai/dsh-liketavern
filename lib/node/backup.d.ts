import { type DoctorIssue } from '../doctor.js';
import { BackupError, type BackupEntry } from './backupFiles.js';
export interface BackupManifest {
    schemaVersion: 1;
    format: 'dsh-tavern-directory-backup';
    scope: 'dsh-home-data-without-installed-dependencies';
    createdAt: string;
    versionSource: 'backup-runtime';
    versions: {
        node: string;
        plugin: string;
        dsh: string;
        expectedDsh: string;
    };
    exclusions: string[];
    entries: BackupEntry[];
}
export interface BackupReport {
    schemaVersion: 1;
    ok: boolean;
    operation: 'create' | 'verify' | 'restore';
    code: string;
    files: number;
    directories: number;
    bytes: number;
    excludedDependencyDirectories: number;
    dependenciesNeedReinstall: boolean;
    offlineDeclared: boolean;
    offlineVerified: false;
    issues: DoctorIssue[];
}
export interface BackupHooks {
    /** 只用于真实文件系统故障注入；CLI 不接受此入口。 */
    afterCopy?: () => Promise<void>;
    beforePublish?: () => Promise<void>;
}
export declare function parseBackupManifest(raw: unknown): BackupManifest;
export declare function createBackup(options: {
    home: string;
    backup: string;
    offline: boolean;
    hooks?: BackupHooks;
}): Promise<BackupReport>;
export declare function verifyBackup(options: {
    backup: string;
}): Promise<BackupReport>;
export declare function restoreBackup(options: {
    backup: string;
    target: string;
    offline: boolean;
    hooks?: BackupHooks;
}): Promise<BackupReport>;
export { BackupError };
