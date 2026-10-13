import { type WorkspaceFs } from './workspaceFs.js';
export declare const TEMPLATE_DATA_PATH = "state/template-data";
export declare const TEMPLATE_DOCUMENT_LIMIT: number;
/** 不超过该字节数的状态整份留在根文件里，不分块。 */
export declare const TEMPLATE_INLINE_LIMIT: number;
/** raw 是要发布的根文件原文，json 是文档本身的序列化（内联时两者相同）。 */
export interface TemplateDocumentWrite {
    raw: string;
    json: string;
    blocks: Map<string, string>;
}
/** 全部预算和结构先在内存检查，拒绝时尚未开始任何正文或 WAL 写入。 */
export declare function prepareTemplateDocument(value: unknown): TemplateDocumentWrite;
/**
 * 重复块不重写；已存在但字节不符属于损坏，不能通过覆盖把损坏隐藏起来。
 * current 是调用方刚读到的根文件原文：只有它仍是本进程最后同步的那一份，才沿用内存里「块已在磁盘」的结论。
 */
export declare function writeTemplateBlocks(fs: WorkspaceFs, document: TemplateDocumentWrite, current: string | null): Promise<void>;
/**
 * 根引用已原子发布：文档的全部块此刻都在磁盘且内容已知，后续保存不必再向磁盘确认未变的块。
 * parsed 是调用方对同一份文档的解析结果（与读取时 parse 的返回值相同），之后的读取直接返回它的副本。
 */
export declare function adoptTemplateDocument(fs: WorkspaceFs, path: string, document: TemplateDocumentWrite, parsed: unknown): void;
/** 读取文档并返回展开后的 JSON；references 收集根可达块的路径。 */
export declare function readTemplateDocument(fs: WorkspaceFs, path: string, references?: Set<string>): Promise<unknown | null>;
/** 展开 WAL 等位置保存的历史根原文，不替换磁盘根，也不改变当前根的缓存结论。 */
export declare function readTemplateDocumentText(fs: WorkspaceFs, raw: string | null, references?: Set<string>): Promise<unknown | null>;
export type TemplateDocumentPath = readonly (string | number)[];
/**
 * 冷读少数字段或指定消息，不先展开无关回复、变量历史或生成正文。返回顺序与 paths 一致，
 * 缺字段为 undefined，根文件不存在为 null；空路径选择整份文档并核对完整展开字节数。
 * 每个实际访问的块都核对摘要与结构，对象分页仍扫描键页，因为旧格式没有按键路由索引。
 * 此读取不产生「整图已验证」或完整解析缓存结论；写入、回滚与完整读取继续核对完整图。
 */
export declare function readTemplateDocumentPaths(fs: WorkspaceFs, path: string, paths: readonly TemplateDocumentPath[]): Promise<Array<unknown | undefined> | null>;
/**
 * 路径读取的业务校验缓存。parse 必须使用稳定函数引用、返回 JSON 值且不依赖可变外部状态；
 * 完整根、写入登记或选择路径变化后重新校验，暖读只复制已校验结果，不再遍历大型重放日志。
 * 与完整文档缓存分开：少数字段解析成功不能使随后完整读取跳过其它历史块。
 */
export declare function loadTemplateDocumentPaths<T>(fs: WorkspaceFs, path: string, paths: readonly TemplateDocumentPath[], parse: (values: Array<unknown | undefined> | null) => T): Promise<T>;
/**
 * 读取并解析文档。根引用与数据块都未变时返回上次解析结果的独立副本，不重复展开与校验；
 * project 接收递归冻结的只读视图，只复制其返回值，避免取少数字段时仍复制全部历史。
 * 同一路径只应由同一个 parse 读取，结果必须是 JSON 值；project 不得修改输入。
 */
export declare function loadTemplateDocument<T>(fs: WorkspaceFs, path: string, parse: (value: unknown | null) => T): Promise<T>;
export declare function loadTemplateDocument<T, R>(fs: WorkspaceFs, path: string, parse: (value: unknown | null) => T, project: (value: Readonly<T>) => R): Promise<R>;
