#!/usr/bin/env node
import { type BackupReport } from './node/backup.js';
interface Arguments {
    command: 'create' | 'verify' | 'restore';
    home?: string;
    backup: string;
    target?: string;
    offline: boolean;
    json: boolean;
}
export declare function parseBackupArguments(args: string[]): Arguments;
export declare function formatBackupText(result: BackupReport): string;
export declare function backupMain(args?: string[], io?: {
    out: (text: string) => void;
    err: (text: string) => void;
}): Promise<number>;
export {};
