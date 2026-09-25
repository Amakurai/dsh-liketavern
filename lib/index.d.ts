/**
 * dsh-liketavern host 入口。
 * 职责：注册设置命名空间、初始化数据目录、安装 agent 预设、提供 tavern 服务、
 * 注册 typert remote 描述符、维护楼层 WAL 与每 turn 缓存（session/event 监听）。
 */
import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-typert-registry';
import { Config } from './node/config.js';
export declare const name = "dsh-liketavern";
export { Config };
export declare const inject: string[];
export declare function apply(ctx: Context, config: ReturnType<typeof Config>): Promise<void>;
