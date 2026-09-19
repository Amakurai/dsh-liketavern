/** 不暴露 parser 或插件对象，避免模板修改其它格式化调用的引擎配置。 */
export declare function createMessageFormatter(): (text: string) => string;
