import type { ProfileContext } from '@deepseek-ai/dsh-app-boot';
export interface PluginAbout {
    version: string;
    hostVersion: string;
    expectedHostVersion: string;
    repositoryUrl: string;
    releasesUrl: string;
    sourceCheckout: boolean;
    desktopHost: boolean;
}
export interface PluginUpdate {
    status: 'current' | 'available' | 'ahead' | 'incompatible';
    latestVersion: string;
    requiredHostVersion: string;
    releaseUrl: string;
    command: string | null;
}
export interface PluginAboutMetadata {
    plugin: unknown;
    host: unknown;
    sourceCheckout: boolean;
}
export interface PluginAboutReaderOptions {
    fetch?: typeof globalThis.fetch;
    readMetadata?: () => Promise<PluginAboutMetadata>;
    /** 启动宿主提供的安装锚点；桌面端的 Node 主入口不属于 CLI 包。 */
    hostProfile?: Pick<ProfileContext, 'name' | 'installAnchor'>;
    /** 只允许缩短默认期限，供工厂测试使用；实际请求期限最多 9 秒。 */
    timeoutMs?: number;
}
export interface PluginAboutReader {
    getPluginAbout(): Promise<PluginAbout>;
    checkPluginUpdate(): Promise<PluginUpdate>;
}
/** 仅从本次 Node 主入口确认宿主；插件旁的开发依赖、PATH 里的其它 dsh 都不能冒充当前运行版本。 */
export declare function readHostEntryMetadata(entry: string | undefined): Promise<unknown | null>;
export declare function createPluginAboutReader(options?: PluginAboutReaderOptions): PluginAboutReader;
export declare const getPluginAbout: () => Promise<PluginAbout>;
export declare const checkPluginUpdate: () => Promise<PluginUpdate>;
