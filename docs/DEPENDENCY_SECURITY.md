# 依赖安全记录

本记录说明依赖告警的处理结果与剩余风险，核对日期为 2026-09-10。`npm audit` 按安装版本匹配公告，不能判断代码中的隔离措施；告警仍须保留可见，不能把测试通过解释为没有漏洞。

## 已更新的依赖

- `js-yaml` 从 4.3.1 更新到 4.3.2，根级 `overrides` 固定补丁版本，锁文件同步更新。该版本修复恶意空映射合并绕过工作量限制的问题（[GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh)）。本仓库通过开发用 dsh / Cordis 依赖引入它；宿主包版本仍为 0.1.2-rc.1。
- `vitest` 从 3.2.7 更新并固定为 4.1.11，相关 `@vitest/*` 包同步更新，修复 redirect mock 越界文件读取（[GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)）。本项目只用 `vitest run` 执行测试，不向外提供 mock 开发服务器；升级仍需运行全量 React、文件系统和 worker 用例。

这些版本约束只作用于本仓库的 npm 安装。发布包不带开发依赖，依赖包的根级 `overrides` 也不会替使用者覆盖其独立安装的 dsh。实际宿主的 `js-yaml` 版本应在宿主安装目录通过 `npm explain js-yaml`（或对应包管理器命令）核对，由宿主依赖升级到兼容的已修复版本；更新本仓库锁文件不等于更新其他安装环境。

## Showdown：保留并验证隔离边界

`showdown` 继续固定为公开 npm 版本 2.1.0；核对时没有包含下列修复的已发布版本。当前 `npm audit` 因此仍报告一项中危受影响依赖，包含三份漏洞公告，不对它做全局忽略。

| 公告 | 触发条件 | 当前保护 |
| --- | --- | --- |
| [GHSA-rmmh-p597-ppvv](https://github.com/advisories/GHSA-rmmh-p597-ppvv) | 恶意嵌套链接使正则长时间计算 | Showdown 只在 worker 内的 QuickJS 中运行；QuickJS 有内存和执行预算，外层 worker 可以强制终止。格式化输入和输出各限制为 1,048,576 个 UTF-16 码元（按字符串长度计）。超时明确失败，不回传半成品。 |
| [GHSA-cr32-g25g-vxjj](https://github.com/advisories/GHSA-cr32-g25g-vxjj) | metadata 与完整 HTML 文档选项同时开启，标题未经转义 | 格式化器显式设置 `metadata: false`、`completeHTMLDocument: false`，覆盖库的全局默认项。 |
| [GHSA-22g5-r2x5-97cx](https://github.com/advisories/GHSA-22g5-r2x5-97cx) | 原始表头拼入 HTML 的 `id` 属性 | 格式化器显式关闭 `tablesHeaderId` 与标题 ID，即使模板设置全局 GitHub 风格也不重新启用。 |

HTML 格式化结果通过 `kind: 'html'` 片段交给现有卡面 iframe，使用 `sandbox="allow-scripts"`，不加 `allow-same-origin`。卡片支持原始 HTML 与脚本，这些选项不是 HTML 清洗器；严禁把结果移入主页面 DOM，业务桥的来源、剧情身份与 WAL 校验仍是必要边界。恶意输入仍可能让当前一次渲染失败，隔离并不意味着 Showdown 本身已修复。

`test/templateSecurity.test.ts` 用手写攻击形状验证完整文档与表头 ID 不会重新开启、HTML 片段的交付类型、嵌套链接超时、主线程响应及失败后的正常渲染。恶意正则输入只在可终止 worker 中运行，不在测试主线程调用原始解析器。

更新 Showdown 或替换 Markdown 引擎时，应重新核对这些公告并运行安全用例、`templateDisplay` 的输出兼容用例和全量测试，再重新构建 `lib/`。不能仅为消除审计计数而换成未发布源码或破坏第三方卡片的格式化语义。
