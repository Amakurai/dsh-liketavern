export declare function getSpeakerHeader(): boolean;
/** true：角色消息显示头像与卡名；false：按宿主原生回复样式只画正文。 */
export declare function setSpeakerHeader(value: boolean): void;
export declare function useSpeakerHeader(): boolean;
export declare function getDisplaySettingsRevision(): number;
/** 全局交互卡开关、网络白名单、展示正则或预设保存后递增，驱动已挂载气泡与后台脚本重读展示配置。 */
export declare function bumpDisplaySettingsRevision(): void;
export declare function useDisplaySettingsRevision(): number;
/** 读取宿主当前主题明暗配色（优先 body[data-ds-dark-theme]，回退根节点 colorScheme 与启动期 theme-source）。 */
export declare function readHostColorScheme(): 'light' | 'dark' | undefined;
