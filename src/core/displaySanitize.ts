/**
 * 展示层收起模型输出的机读标签与未闭合的 HTML 小部件。不改会话存储，不进入 prompt。
 *
 * 社区预设常让模型在正文末尾写 UpdateVariable，或贴一段日志小部件 HTML。
 * 预设若没带展示正则，Markdown 会把这些当正文渲染。封面整页 HTML 原样留给 iframe；
 * 小部件 HTML 后面若还有正文，拆开后只对正文做收起。
 */
import { collectRenderedHtml } from './regex.js'

export const DISPLAY_META_TAGS = [
  'UpdateVariable',
  'JSONPatch',
  'Analysis',
  'think',
  'thinking',
  'StatusPlaceHolderImpl',
] as const

function isCoverHtml(text: string): boolean {
  return /<!DOCTYPE\s+html/i.test(text) || /<html[\s>]/i.test(text) || /<body[\s>]/i.test(text)
}

function stripClosedAndEmpty(text: string): string {
  let out = text
  for (let pass = 0; pass < 8; pass++) {
    let next = out
    for (const tag of DISPLAY_META_TAGS) {
      next = next.replace(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'), '')
      next = next.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), '')
    }
    next = next.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    next = next.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '')
    if (next === out) break
    out = next
  }
  return out
}

/** 未闭合的协议标签（流式输出到一半）从开标签切到文末。 */
function stripUnclosedMeta(text: string): string {
  let cut = -1
  for (const tag of DISPLAY_META_TAGS) {
    const re = new RegExp(`<${tag}\\b`, 'gi')
    const match = re.exec(text)
    if (match && (cut < 0 || match.index < cut)) cut = match.index
  }
  return cut >= 0 ? text.slice(0, cut) : text
}

/**
 * 日志/折叠小部件几乎总是接在正文之后，且经常标签没闭合。
 * 从第一个特征开标签切到文末，避免半截 HTML 露出来。
 */
function stripWidgetTail(text: string): string {
  const markers = [
    /<div\b[^>]*\bstream-log\b/i,
    /<details\b[^>]*\b[\w-]*-box\b/i,
    /<div\b[^>]*\b[\w-]*-box\b/i,
    /<style\b/i,
  ]
  let cut = -1
  for (const re of markers) {
    const match = re.exec(text)
    if (match && (cut < 0 || match.index < cut)) cut = match.index
  }
  return cut >= 0 ? text.slice(0, cut) : text
}

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

/** 去掉展示不该看见的机读块与小部件；角色正文保留。 */
export function stripDisplayMeta(text: string): string {
  if (!text) return text
  if (isCoverHtml(text)) return text
  return tidy(stripWidgetTail(stripUnclosedMeta(stripClosedAndEmpty(stripHtmlComments(text)))))
}

/**
 * 正则渲染后的展示拆分：交互卡 HTML 进 iframe（可能连续多段），剩余正文再收起机读标签。
 * `allowHtml` 为 false 时整段当文本（交互卡开关关闭）。
 */
export function presentRenderedOutput(
  rendered: string,
  allowHtml: boolean,
): { html: string | null; htmls: string[]; text: string } {
  const { htmls, rest } = collectRenderedHtml(rendered)
  if (!allowHtml) {
    return { html: null, htmls: [], text: stripDisplayMeta(rest || rendered) }
  }
  return {
    html: htmls[0] ?? null,
    htmls,
    text: stripDisplayMeta(rest),
  }
}
