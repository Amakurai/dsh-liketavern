/**
 * core 层分词检索、别名治理与宿主 Markdown 展示归一化回归测试：
 * 覆盖扩展汉字 UTF-16 代理对撇号词尾剥离、纯 ASCII 快速分词与非 ASCII 语义等价、
 * BM25 槽位缓冲与长度归一化惰性缓存的跨轮增删一致性、记忆别名对带句末标点正文的照抄过滤、
 * 以及宿主 Markdown 在 emoji/扩展汉字代理对贴合边界、反斜杠 URL 转义和图片 alt 孤立回车下的 CommonMark 正确性。
 */
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../../src/core/bm25.js'
import { continuedMarkdown } from '../../src/core/continuationMarkdown.js'
import { normalizeHostMarkdown } from '../../src/core/hostMarkdown.js'
import { findHtmlFragment } from '../../src/core/htmlFragment.js'
import { normalizeAliases } from '../../src/core/memoryAliases.js'
import { parsePlainDetailsBlocks } from '../../src/core/plainDetails.js'
import { analyzeText, tokenize } from '../../src/core/tokenize.js'

const md = new MarkdownIt('commonmark')

describe('分词、BM25 检索缓存与记忆别名归一化', () => {
  it('扩展平面汉字（UTF-16 代理对）后的英文所有格词尾正确识别为 clitic，同时保留独立单字母角色名', () => {
    expect(tokenize("𠮷's blade and 𠀋’s scroll")).toEqual(['𠮷', 'blade', 'and', '𠀋', 'scroll'])
    expect(analyzeText("𠮷ʼs").terms).toEqual(['𠮷'])
    expect(tokenize("Agent M and 小 S's plan")).toEqual(['agent', 'm', 'and', 's', 'plan'])
    expect(tokenize('Agent M and 小 S')).toEqual(['agent', 'm', 'and', 's'])
  })

  it('纯 ASCII 快速路径与含非 ASCII 空白的通用路径在连字符、撇号词尾及 lone 判定上逐项一致', () => {
    const asciiSamples = [
      '',
      '   ---   ',
      "it's don't we'll they're I've I'm he'd",
      "don't_know foo_bar long-term foo--bar _edge_ -dash-",
      "'s M T S 42",
    ]
    for (const sample of asciiSamples) {
      // 拼接全角空格 `\u3000` 强制走非 ASCII 正则分支，验证两条路径输出完全相同
      const viaUnicode = analyzeText(`${sample}\u3000`)
      const viaAscii = analyzeText(sample)
      expect(tokenize(sample), sample).toEqual(viaUnicode.terms)
      expect(viaAscii, sample).toEqual(viaUnicode)
    }
  })

  it('Bm25Index 复用槽位缓冲与按代次归一化缓存在增删改查及次级单字加分下保持精确得分', () => {
    const index = new Bm25Index<{ tag: string }>()
    for (let i = 0; i < 60; i++) {
      const med = i % 5 === 0 ? '草药箱' : i % 5 === 1 ? '取药筒' : '旁观者'
      index.add({
        id: `doc-${String(i).padStart(2, '0')}`,
        text: `shared archive topic${i % 12} ${med}`,
        keys: i === 0 ? ['樱'] : [],
        ts: 1_000_000 - i * 1000,
        data: { tag: `t${i}` },
      })
    }

    // 首次冷缓存与二次热缓存查询得分逐位一致
    const first = index.search('shared topic0', { topK: 5, halfLifeMs: 86_400_000, now: 1_000_000 })
    const second = index.search('shared topic0', { topK: 5, halfLifeMs: 86_400_000, now: 1_000_000 })
    expect(second).toEqual(first)
    expect(first[0]?.id).toBe('doc-00')

    // 稀疏主证据 + 次级单字加分路径读取同一归一化缓存
    const withSecondary = index.search('樱 药还够吗', { topK: 5 })
    expect(withSecondary[0]?.id).toBe('doc-00')

    // 修改文档长度后代次推进，归一化因子与 similarity 缓存立即更新，不残留旧分
    const simBefore = index.similarity('shared archive topic0 草药箱', { topK: 3 })
    expect(simBefore[0]).toMatchObject({ id: 'doc-00', score: 1 })

    index.add({
      id: 'doc-00',
      text: 'shared archive topic0 草药箱 额外补充很长一段新的背景描述文字以改变平均文档长度',
      keys: ['樱'],
      ts: 1_000_000,
    })
    const afterUpdate = index.search('shared topic0', { topK: 5, halfLifeMs: 86_400_000, now: 1_000_000 })
    expect(afterUpdate[0]?.score).not.toBe(first[0]?.score)

    index.remove('doc-00')
    expect(index.search('樱', { topK: 5 })).toEqual([])
  })

  it('normalizeAliases 过滤与带句号/引号/全角字符正文等价的照抄别名，保留有效同义词', () => {
    const aliases = normalizeAliases(
      ['止痛剂少了两箱', '「止痛剂少了两箱。」', '药品', '失窃', '偷药'],
      '止痛剂少了两箱。',
    )
    expect(aliases).toEqual(['药品', '失窃', '偷药'])

    const nfkcAliases = normalizeAliases(['ＡＢＣ 计划', 'B方案'], '  abc\n计划！ ')
    expect(nfkcAliases).toEqual(['B方案'])
  })
})

describe('宿主 Markdown 展示归一化与跨段代码/折叠块边界', () => {
  it('正确识别 emoji 与扩展汉字代理对的 CommonMark 贴合边界，不输出裸露星号', () => {
    // 字母紧贴 emoji，或非 cjkFriendly 斜体/删除线紧贴扩展汉字时，CommonMark 不构成有效 flanking，必须保留原安全 HTML
    expect(normalizeHostMarkdown('Alice<b>🔥fire</b>')).toBe('Alice<b>🔥fire</b>')
    expect(normalizeHostMarkdown('<b>🔥</b>Alice')).toBe('<b>🔥</b>Alice')
    expect(normalizeHostMarkdown('<i>🔥</i>𠮷')).toBe('<i>🔥</i>𠮷')
    expect(normalizeHostMarkdown('<s>🔥</s>𠮷')).toBe('<s>🔥</s>𠮷')
    expect(md.renderInline('*🔥*𠮷')).toBe('*🔥*𠮷')

    // 有空白或标点（含行内代码反引号）分隔时正常转为 ** 并由 CommonMark 渲染出 <strong>
    const validEmojiBold = normalizeHostMarkdown('Alice <b>🔥fire</b>!')
    expect(validEmojiBold).toBe('Alice **🔥fire**!')
    expect(md.renderInline(validEmojiBold)).toBe('Alice <strong>🔥fire</strong>!')
    expect(normalizeHostMarkdown('<b>🔥</b>`🔥`')).toBe('**🔥**`🔥`')
    expect(md.renderInline('**🔥**`🔥`')).toBe('<strong>🔥</strong><code>🔥</code>')

    // 扩展平面汉字（𠮷 U+20BB7）与基本区汉字具有相同的 cjkFriendly 加粗贴合能力
    expect(normalizeHostMarkdown('<b>🔥</b>𠮷')).toBe('**🔥**𠮷')
    expect(normalizeHostMarkdown('𠮷<b>「不要走。」</b>𠮷')).toBe('𠮷**「不要走。」**𠮷')
  })

  it('转义 http(s) 链接与图片 URL 中的反斜杠防止 \\) 逃逸闭合括号，并折叠图片 alt 中的孤立回车', () => {
    const linkWithSlash = normalizeHostMarkdown('<a href="https://example.com/path\\">查看详情</a>（附注）')
    expect(linkWithSlash).toBe('[查看详情](https://example.com/path%5C)（附注）')
    expect(md.renderInline(linkWithSlash)).toBe('<a href="https://example.com/path%5C">查看详情</a>（附注）')

    const imgWithCr = normalizeHostMarkdown('<img src="https://example.com/cg\\1.png" alt="第一行&#13;第二行">')
    expect(imgWithCr).toBe('![第一行 第二行](https://example.com/cg%5C1.png)')
    expect(md.renderInline(imgWithCr)).toContain('<img src="https://example.com/cg%5C1.png" alt="第一行 第二行" />')
  })

  it('复用扫描器与预编译边界正则时，跨消息代码续写与纯折叠块后置无关样式拆分保持精确', () => {
    const cont = continuedMarkdown('<div>卡片</div>\n```ts\nconst x = 1;\n', 'const y = 2;\n```\n后续台词')
    expect(cont?.text).toContain('```ts\nconst y = 2;\n```\n后续台词')

    const detailsWithCode = '<details><summary>展开</summary>\n\n行内 `<details>x</details>` 示例\n\n</details>\n<style>.card { color: red; }</style><div class="card">独立卡面</div>'
    const firstFrag = findHtmlFragment(detailsWithCode)
    expect(firstFrag).not.toBeNull()
    const plain = parsePlainDetailsBlocks(detailsWithCode.slice(firstFrag!.start, firstFrag!.end))
    expect(plain).toEqual([
      {
        open: false,
        summary: '展开',
        children: [{ kind: 'markdown', text: '行内 `<details>x</details>` 示例' }],
      },
    ])
  })
})
