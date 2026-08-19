/**
 * typert 远端契约（手写，模仿 dsh-typert-generator 产物形态）。
 * host 侧经 ctx.typert.register(TYPERT_HOST) 注册；client 侧经 ctx.remote.$mount(TYPERT_REMOTE) 挂载。
 * 结果 schema 描述裸业务值；{ ok, value | error } 信封是 gateway 传输层约定，
 * 由 host invokeRpc / client invoke 自动生成，这里不能再包。
 * 复杂资产（卡片/预设/世界书 JSON）用宽松 schema，由存储层归一化时严格校验。
 */
import { z } from 'zod';
/** host 侧贡献：注册进 ctx.typert（gateway 以 strict codec 校验出入参）。 */
export declare const TYPERT_HOST: {
    package: string;
    face: "host";
    schemas: unknown[];
    invocations: {
        id: string;
        service: string;
        namespace: string;
        method: string;
        invocation: {
            kind: "direct";
        };
        parameters: {
            name: string;
            wire: string;
            source: "json";
            codec: {
                mode: "strict";
                typeSymbol: string;
                schema: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
            };
        }[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
        };
    }[];
    model: {
        services: {
            description: string;
            summary: string;
            tags: string[];
            jsDoc: string;
            key: string;
            exportName: string;
            members: {
                kind: string;
                name: string;
                signature: string;
                summary: string;
                jsDoc: string;
            }[];
            types: unknown[];
        }[];
        events: unknown[];
        objects: unknown[];
    };
};
/** client 侧贡献：ctx.remote.$mount(TYPERT_REMOTE) 后以 ctx.remote.tavern.<method>(request) 调用。 */
export declare const TYPERT_REMOTE: {
    package: string;
    descriptors: {
        id: string;
        service: string;
        namespace: string;
        method: string;
        invocation: {
            kind: "direct";
        };
        parameters: {
            name: string;
            wire: string;
            source: "json";
            codec: {
                mode: "strict";
                typeSymbol: string;
                schema: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
            };
        }[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>;
        };
    }[];
};
