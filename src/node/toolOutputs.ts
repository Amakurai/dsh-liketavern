/** Tavern 工具的规范 JSON 返回结构：供宿主验证与 PTC SDK 生成，避免程序猜测结果字段或解析展示文本。 */
import type { InferValue, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'

const string = { type: 'string' } as const
const number = { type: 'number' } as const
const boolean = { type: 'boolean' } as const
const strings = { type: 'array', items: string } as const
const base = { ok: { ...boolean, required: true }, error: string, hint: string, errorTruncated: boolean, tokensUsed: number } as const
const loreEntry = {
  type: 'object', additionalProperties: false,
  properties: {
    uid: { ...string, required: true }, key: string, source: string, sourceRef: string,
    comment: string, keys: strings, enabled: boolean, constant: boolean,
    content: string, truncated: boolean, preview: string, tokens: number,
    metadataTruncated: boolean, keysOmitted: number,
  },
} as const
const preset = {
  type: 'object', additionalProperties: false,
  properties: {
    id: string, name: string, mode: string, identifier: string, entryName: string,
    enabled: boolean, role: string, marker: boolean,
    markerId: { oneOf: [string, { type: 'null' }] },
    truncated: boolean, tokens: number, content: string, count: number, omitted: number,
    tokensUsed: number, metadataTruncated: boolean, idOmitted: boolean, markerIdOmitted: boolean,
    entries: { type: 'array', items: { type: 'object', additionalProperties: false,
      properties: { identifier: string, name: string, enabled: boolean, role: string,
        position: string, marker: boolean, markerId: { oneOf: [string, { type: 'null' }] },
        tokens: number, preview: string, truncated: boolean } } },
  },
} as const

/** ok=false 为业务拒绝（含相似记忆）；宿主调度/参数/运行时失败另由 ToolCallError 表达。 */
export const TOOL_OUTPUTS = {
  memorySearch: {
    type: 'object', additionalProperties: false,
    properties: { ...base, count: number, tokensUsed: number, omitted: number, truncated: boolean,
      results: { type: 'array', items: { type: 'object', additionalProperties: false,
        properties: {
          id: { ...string, required: true }, path: string, archived: boolean, sourceRange: string,
          score: number, tags: strings, keys: strings, body: { ...string, required: true },
          truncated: boolean, omitted: boolean, metadataTruncated: boolean,
          tagsTruncated: boolean, keysTruncated: boolean, sourceRangeOmitted: boolean,
        } } },
    },
  },
  memoryWrite: {
    type: 'object', additionalProperties: false,
    properties: { ...base, id: string, overLength: boolean, compressScheduled: boolean, indexUpdated: boolean,
      status: string, similarId: string, similarBody: string, similarBodyTruncated: boolean, tokensUsed: number },
  },
  memoryUpdate: {
    type: 'object', additionalProperties: false,
    properties: { ...base, id: string, updated: string, indexUpdated: boolean },
  },
  loreRead: {
    type: 'object', additionalProperties: false,
    properties: { ...base, mode: string, count: number, truncated: boolean,
      tokensUsed: number, omitted: number, entries: { type: 'array', items: loreEntry } },
  },
  worldstateUpdate: {
    type: 'object', additionalProperties: false,
    properties: { ...base, id: string, indexUpdated: boolean },
  },
  assetList: {
    type: 'object', additionalProperties: false,
    properties: { ...base, tokensUsed: number, truncated: boolean,
      index: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
        properties: { updatedAt: string, count: number, omitted: number, truncated: boolean,
          tokensUsed: number, metadataTruncated: boolean,
          files: { type: 'array', items: { type: 'object', additionalProperties: false,
            properties: { path: string, summary: string, tokens: number, truncated: boolean } } } } }] },
      memory: { type: 'object', additionalProperties: false, properties: { count: number, tokens: number } },
      files: strings, fileCount: number, filesTruncated: boolean, filesOmitted: number, filesTokensUsed: number, preset },
  },
  assetRead: {
    type: 'object', additionalProperties: false,
    properties: { ...base, tokensUsed: number, truncated: boolean, preset,
      file: { type: 'object', additionalProperties: false,
        properties: { path: string, truncated: boolean, tokens: number, content: string } } },
  },
} as const satisfies Record<string, ValueSchemaSpec>

export type TavernToolOutput<K extends keyof typeof TOOL_OUTPUTS> = InferValue<(typeof TOOL_OUTPUTS)[K]>
