export declare function getSpeakerHeader(): boolean;
/** true：角色消息显示头像与卡名；false：按宿主原生回复样式只画正文。 */
export declare function setSpeakerHeader(value: boolean): void;
export declare function useSpeakerHeader(): boolean;
/** 读取宿主当前主题明暗配色（优先 body[data-ds-dark-theme]，回退根节点 colorScheme）。 */
export declare function readHostColorScheme(): 'light' | 'dark' | undefined;
