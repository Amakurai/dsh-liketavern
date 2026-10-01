/** Tavern 工具的规范 JSON 返回结构：供宿主验证与 PTC SDK 生成，避免程序猜测结果字段或解析展示文本。 */
import type { InferValue } from '@deepseek-ai/dsh-tools';
/** ok=false 为业务拒绝（含相似记忆）；宿主调度/参数/运行时失败另由 ToolCallError 表达。 */
export declare const TOOL_OUTPUTS: {
    readonly memorySearch: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly count: {
                readonly type: "number";
            };
            readonly tokensUsed: {
                readonly type: "number";
            };
            readonly omitted: {
                readonly type: "number";
            };
            readonly truncated: {
                readonly type: "boolean";
            };
            readonly results: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly id: {
                            readonly required: true;
                            readonly type: "string";
                        };
                        readonly path: {
                            readonly type: "string";
                        };
                        readonly archived: {
                            readonly type: "boolean";
                        };
                        readonly sourceRange: {
                            readonly type: "string";
                        };
                        readonly score: {
                            readonly type: "number";
                        };
                        readonly tags: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly keys: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly body: {
                            readonly required: true;
                            readonly type: "string";
                        };
                        readonly truncated: {
                            readonly type: "boolean";
                        };
                        readonly omitted: {
                            readonly type: "boolean";
                        };
                        readonly metadataTruncated: {
                            readonly type: "boolean";
                        };
                        readonly tagsTruncated: {
                            readonly type: "boolean";
                        };
                        readonly keysTruncated: {
                            readonly type: "boolean";
                        };
                        readonly sourceRangeOmitted: {
                            readonly type: "boolean";
                        };
                    };
                };
            };
            readonly ok: {
                readonly required: true;
                readonly type: "boolean";
            };
            readonly error: {
                readonly type: "string";
            };
            readonly hint: {
                readonly type: "string";
            };
            readonly errorTruncated: {
                readonly type: "boolean";
            };
        };
    };
    readonly memoryWrite: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly id: {
                readonly type: "string";
            };
            readonly overLength: {
                readonly type: "boolean";
            };
            readonly compressScheduled: {
                readonly type: "boolean";
            };
            readonly indexUpdated: {
                readonly type: "boolean";
            };
            readonly status: {
                readonly type: "string";
            };
            readonly similarId: {
                readonly type: "string";
            };
            readonly similarBody: {
                readonly type: "string";
            };
            readonly similarBodyTruncated: {
                readonly type: "boolean";
            };
            readonly tokensUsed: {
                readonly type: "number";
            };
            readonly ok: {
                readonly required: true;
                readonly type: "boolean";
            };
            readonly error: {
                readonly type: "string";
            };
            readonly hint: {
                readonly type: "string";
            };
            readonly errorTruncated: {
                readonly type: "boolean";
            };
        };
    };
    readonly memoryUpdate: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly id: {
                readonly type: "string";
            };
            readonly updated: {
                readonly type: "string";
            };
            readonly indexUpdated: {
                readonly type: "boolean";
            };
            readonly ok: {
                readonly required: true;
                readonly type: "boolean";
            };
            readonly error: {
                readonly type: "string";
            };
            readonly hint: {
                readonly type: "string";
            };
            readonly errorTruncated: {
                readonly type: "boolean";
            };
            readonly tokensUsed: {
                readonly type: "number";
            };
        };
    };
    readonly loreRead: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly mode: {
                readonly type: "string";
            };
            readonly count: {
                readonly type: "number";
            };
            readonly truncated: {
                readonly type: "boolean";
            };
            readonly tokensUsed: {
                readonly type: "number";
            };
            readonly omitted: {
                readonly type: "number";
            };
            readonly entries: {
                readonly type: "array";
                readonly items: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly uid: {
                            readonly required: true;
                            readonly type: "string";
                        };
                        readonly key: {
                            readonly type: "string";
                        };
                        readonly source: {
                            readonly type: "string";
                        };
                        readonly sourceRef: {
                            readonly type: "string";
                        };
                        readonly comment: {
                            readonly type: "string";
                        };
                        readonly keys: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly enabled: {
                            readonly type: "boolean";
                        };
                        readonly constant: {
                            readonly type: "boolean";
                        };
                        readonly content: {
                            readonly type: "string";
                        };
                        readonly truncated: {
                            readonly type: "boolean";
                        };
                        readonly preview: {
                            readonly type: "string";
                        };
                        readonly tokens: {
                            readonly type: "number";
                        };
                        readonly metadataTruncated: {
                            readonly type: "boolean";
                        };
                        readonly keysOmitted: {
                            readonly type: "number";
                        };
                    };
                };
            };
            readonly ok: {
                readonly required: true;
                readonly type: "boolean";
            };
            readonly error: {
                readonly type: "string";
            };
            readonly hint: {
                readonly type: "string";
            };
            readonly errorTruncated: {
                readonly type: "boolean";
            };
        };
    };
    readonly worldstateUpdate: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly id: {
                readonly type: "string";
            };
            readonly indexUpdated: {
                readonly type: "boolean";
            };
            readonly ok: {
                readonly required: true;
                readonly type: "boolean";
            };
            readonly error: {
                readonly type: "string";
            };
            readonly hint: {
                readonly type: "string";
            };
            readonly errorTruncated: {
                readonly type: "boolean";
            };
            readonly tokensUsed: {
                readonly type: "number";
            };
        };
    };
    readonly assetList: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly tokensUsed: {
                readonly type: "number";
            };
            readonly truncated: {
                readonly type: "boolean";
            };
            readonly index: {
                readonly oneOf: readonly [{
                    readonly type: "null";
                }, {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly updatedAt: {
                            readonly type: "string";
                        };
                        readonly count: {
                            readonly type: "number";
                        };
                        readonly omitted: {
                            readonly type: "number";
                        };
                        readonly truncated: {
                            readonly type: "boolean";
                        };
                        readonly tokensUsed: {
                            readonly type: "number";
                        };
                        readonly metadataTruncated: {
                            readonly type: "boolean";
                        };
                        readonly files: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "object";
                                readonly additionalProperties: false;
                                readonly properties: {
                                    readonly path: {
                                        readonly type: "string";
                                    };
                                    readonly summary: {
                                        readonly type: "string";
                                    };
                                    readonly tokens: {
                                        readonly type: "number";
                                    };
                                    readonly truncated: {
                                        readonly type: "boolean";
                                    };
                                };
                            };
                        };
                    };
                }];
            };
            readonly memory: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly properties: {
                    readonly count: {
                        readonly type: "number";
                    };
                    readonly tokens: {
                        readonly type: "number";
                    };
                };
            };
            readonly files: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly fileCount: {
                readonly type: "number";
            };
            readonly filesTruncated: {
                readonly type: "boolean";
            };
            readonly filesOmitted: {
                readonly type: "number";
            };
            readonly filesTokensUsed: {
                readonly type: "number";
            };
            readonly preset: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly name: {
                        readonly type: "string";
                    };
                    readonly mode: {
                        readonly type: "string";
                    };
                    readonly identifier: {
                        readonly type: "string";
                    };
                    readonly entryName: {
                        readonly type: "string";
                    };
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly role: {
                        readonly type: "string";
                    };
                    readonly marker: {
                        readonly type: "boolean";
                    };
                    readonly markerId: {
                        readonly oneOf: readonly [{
                            readonly type: "string";
                        }, {
                            readonly type: "null";
                        }];
                    };
                    readonly truncated: {
                        readonly type: "boolean";
                    };
                    readonly tokens: {
                        readonly type: "number";
                    };
                    readonly content: {
                        readonly type: "string";
                    };
                    readonly count: {
                        readonly type: "number";
                    };
                    readonly omitted: {
                        readonly type: "number";
                    };
                    readonly tokensUsed: {
                        readonly type: "number";
                    };
                    readonly metadataTruncated: {
                        readonly type: "boolean";
                    };
                    readonly idOmitted: {
                        readonly type: "boolean";
                    };
                    readonly markerIdOmitted: {
                        readonly type: "boolean";
                    };
                    readonly entries: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly identifier: {
                                    readonly type: "string";
                                };
                                readonly name: {
                                    readonly type: "string";
                                };
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly role: {
                                    readonly type: "string";
                                };
                                readonly position: {
                                    readonly type: "string";
                                };
                                readonly marker: {
                                    readonly type: "boolean";
                                };
                                readonly markerId: {
                                    readonly oneOf: readonly [{
                                        readonly type: "string";
                                    }, {
                                        readonly type: "null";
                                    }];
                                };
                                readonly tokens: {
                                    readonly type: "number";
                                };
                                readonly preview: {
                                    readonly type: "string";
                                };
                                readonly truncated: {
                                    readonly type: "boolean";
                                };
                            };
                        };
                    };
                };
            };
            readonly ok: {
                readonly required: true;
                readonly type: "boolean";
            };
            readonly error: {
                readonly type: "string";
            };
            readonly hint: {
                readonly type: "string";
            };
            readonly errorTruncated: {
                readonly type: "boolean";
            };
        };
    };
    readonly assetRead: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly tokensUsed: {
                readonly type: "number";
            };
            readonly truncated: {
                readonly type: "boolean";
            };
            readonly preset: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                    };
                    readonly name: {
                        readonly type: "string";
                    };
                    readonly mode: {
                        readonly type: "string";
                    };
                    readonly identifier: {
                        readonly type: "string";
                    };
                    readonly entryName: {
                        readonly type: "string";
                    };
                    readonly enabled: {
                        readonly type: "boolean";
                    };
                    readonly role: {
                        readonly type: "string";
                    };
                    readonly marker: {
                        readonly type: "boolean";
                    };
                    readonly markerId: {
                        readonly oneOf: readonly [{
                            readonly type: "string";
                        }, {
                            readonly type: "null";
                        }];
                    };
                    readonly truncated: {
                        readonly type: "boolean";
                    };
                    readonly tokens: {
                        readonly type: "number";
                    };
                    readonly content: {
                        readonly type: "string";
                    };
                    readonly count: {
                        readonly type: "number";
                    };
                    readonly omitted: {
                        readonly type: "number";
                    };
                    readonly tokensUsed: {
                        readonly type: "number";
                    };
                    readonly metadataTruncated: {
                        readonly type: "boolean";
                    };
                    readonly idOmitted: {
                        readonly type: "boolean";
                    };
                    readonly markerIdOmitted: {
                        readonly type: "boolean";
                    };
                    readonly entries: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "object";
                            readonly additionalProperties: false;
                            readonly properties: {
                                readonly identifier: {
                                    readonly type: "string";
                                };
                                readonly name: {
                                    readonly type: "string";
                                };
                                readonly enabled: {
                                    readonly type: "boolean";
                                };
                                readonly role: {
                                    readonly type: "string";
                                };
                                readonly position: {
                                    readonly type: "string";
                                };
                                readonly marker: {
                                    readonly type: "boolean";
                                };
                                readonly markerId: {
                                    readonly oneOf: readonly [{
                                        readonly type: "string";
                                    }, {
                                        readonly type: "null";
                                    }];
                                };
                                readonly tokens: {
                                    readonly type: "number";
                                };
                                readonly preview: {
                                    readonly type: "string";
                                };
                                readonly truncated: {
                                    readonly type: "boolean";
                                };
                            };
                        };
                    };
                };
            };
            readonly file: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly properties: {
                    readonly path: {
                        readonly type: "string";
                    };
                    readonly truncated: {
                        readonly type: "boolean";
                    };
                    readonly tokens: {
                        readonly type: "number";
                    };
                    readonly content: {
                        readonly type: "string";
                    };
                };
            };
            readonly ok: {
                readonly required: true;
                readonly type: "boolean";
            };
            readonly error: {
                readonly type: "string";
            };
            readonly hint: {
                readonly type: "string";
            };
            readonly errorTruncated: {
                readonly type: "boolean";
            };
        };
    };
};
export type TavernToolOutput<K extends keyof typeof TOOL_OUTPUTS> = InferValue<(typeof TOOL_OUTPUTS)[K]>;
