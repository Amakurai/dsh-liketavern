# CI、测试与发布

## 检查顺序

`.github/workflows/ci.yml` 同时用于 main push、PR、手动运行和 Release 的 `workflow_call`。

Release 也支持在 Actions 的 `release` 页面手动运行：选择 `main`，填写与包版本一致的新标签（例如 `v0.5.11`）。复用的 CI 会先校验分支、版本和发布说明，再运行完整双平台检查。只有这些检查、主分支世系校验及 artifact 校验全部成功，发布 job 才把新标签固定到本次已验证的 SHA，并发布该 run 的原始安装包；已有标签只能指向相同提交，手工推送的 `v*` 标签也必须位于 `main` 历史内（`compare/main...SHA` 的 `ahead_by == 0`），绝不移动旧标签或发布分叉提交。手动入口与 tag push 按同一标签串行，均不会取消已开始的发布验证。

1. `verify (ubuntu-latest)` 先用固定版本、固定 SHA-256 的 actionlint 检查全部 GitHub Actions workflows（`ci.yml`、`release.yml`、`hol-plugin-scanner.yml`），校验发布元数据，安装锁定依赖，执行 `host:check` 与 `npm audit --package-lock-only`（审计完整锁文件而非单平台安装子集），完成构建并校验 `lib/` 与 `presets/` 无变动或遗漏文件，执行 doctor/backup 安装入口冒烟，最后只打包一次生成真实 tarball 与 SHA-256。任一环节失败会立即终止后续任务，避免浪费多台测试与 Windows 机器。
2. Ubuntu `verify` 通过后，并行启动 `verify (windows-latest)` 与八台独立测试 runner：
   - `verify (windows-latest)` 在 Windows 环境独立验证锁定依赖安装、`host:check`、首次检出重建一致性、doctor/backup 链接入口以及直接调用 Node 脚本时的 `npm.cmd` 打包白名单分支。
   - `tests` 在 Ubuntu、Windows 各启动 `--shard=1/4` 至 `--shard=4/4` 四片独立 runner。`vitest.config.ts` 接入 `scripts/shard-tests.mjs` 的确定性 LPT（最长处理时间优先）分片器，按双平台实测耗时基线将重型沙箱、WAL 故障矩阵与宿主集成套件均匀分散到各片，片内优先执行重型套件；每台 runner 内仍保持 `maxWorkers=1`。测试直接使用已验证与源码一致的入库 `lib/`，不重复构建。
3. `CI checks` 汇总 `verify (ubuntu-latest)`、`verify (windows-latest)` 与 `tests` 的全部结果并写入阶段摘要；任一阶段失败、跳过或取消均不能通过。分支保护可选择这个稳定名称。

`.github/workflows/hol-plugin-scanner.yml` 仅在 `main` 分支推送、PR 和手动触发时运行，并按 PR 编号或引用去重取消旧任务，避免同一分支推送与 PR 重复触发或污染版本标签推送。`.github/dependabot.yml` 将 Actions 与常规 minor/patch 依赖更新分组，并忽略需同步重建入库 `lib/vendor/*` 及登记模板运行时旧指纹的沙箱库版本演进（安全漏洞仍由 `npm audit` 与 GitHub Advisory 拦截）。

分片通过增加独立机器与耗时均衡调度缩短墙钟时间；它不减少双平台测试覆盖，也不放宽 QuickJS 的产品执行期限。单个集成测试确实包含多段文件系统事务时，可以说明理由后单独配置总时限。

同一分支或 PR 的新提交会取消旧 CI；Release 与复用的验证使用不同 concurrency 组，同一 tag 的发布不会互相取消。矩阵 `fail-fast: false`，一次失败仍能收集其它片的结果。

`.gitattributes` 将文本源码、脚本与生成产物的检出统一为 LF，确保 Windows 首次检出与构建输出一致。只固定 `lib/` 不够：TypeScript 会保留多行模板源码的原始行尾，仍可能输出混合换行。二进制自动识别保持开启，固定检查点引擎仍由后置 `-text` 规则保留原始字节。不能只在已有工作区里重建验证：`buildCheckout.test.ts` 核对双平台 `verify` 共用同一份守卫脚本，并使用真实 Git 首次 clone 分别覆盖 `core.autocrlf=true/false`，实际编译检出的多行模板并执行 workflow 原始守卫，确认真实内容变动、缺失文件和未跟踪产物仍被拒绝。

## 本地复现

通常先运行：

```bash
npm ci
npm run host:check
npm run build
npm test
npm run doctor:check
npm run backup:check
npm run package:check
```

复现 CI 的单 worker、LPT 分片与报告行为（PowerShell）：

```powershell
$env:CI = 'true'
$env:GITHUB_ACTIONS = 'true'
npm test -- --shard=1/4
node scripts/summarize-tests.mjs .vitest/results.json
```

POSIX shell：

```bash
CI=true GITHUB_ACTIONS=true npm test -- --shard=1/4
node scripts/summarize-tests.mjs .vitest/results.json
```

其余分片改为 `--shard=2/4`、`--shard=3/4`、`--shard=4/4`。定位到某个文件后可直接 `npm test -- test/toolWriteReceipt.test.ts`。报告默认覆盖 `.vitest/results.json` 和 `.vitest/junit.xml`；连续本地运行需先复制想保留的报告，也可用 `--outputFile.json=.vitest/shard2.json --outputFile.junit=.vitest/shard2.xml` 指定独立输出。`.vitest/` 已被 Git 忽略。

正常全量运行不需要设置这些环境变量，仍使用原来的本地 worker 数与终端 reporter。没有统一重试；测试失败应保留，不能通过自动重跑隐藏。

布局 effect 的生命周期使用 `draftDomLifecycle.test.tsx` 的真实 React DOM 回归：React 18 测试渲染器不会执行浏览器 Suspense 隐藏时的布局清理，也不能替代并发根下的 StrictMode 重放。该文件使用锁定的 jsdom 开发依赖，先验证故障场景确实清理并恢复布局 effect，再断言草稿恢复、宿主回执与页面离开保护；普通编辑器回归继续使用轻量渲染器。当前 jsdom 要求 Node 24.15 或更新的 24.x，双平台 CI 使用当前 Node 24；它不进入运行 bundle。

## 失败诊断

每片的 Actions Summary 包含通过/失败/跳过计数、失败用例、失败文件以及耗时最高的十个文件和用例。即使测试失败，也上传 `test-results-<系统>-<分片>`，保留 14 天：

- `results.json`：包含测试结果、时间、断言与错误，可用于后续耗时比较与重型套件基线校准。
- `junit.xml`：供 JUnit 工具读取，不重复附带全部 console 输出。

显式 reporter 列表保留 `github-actions`，失败仍能生成源代码注解。若测试进程在生成报告前崩溃，摘要和上传步骤明确失败，并保留此前的测试错误；不会输出一个空的成功摘要。

宿主兼容桩仅在项目代码实际导入后端 `@deepseek-ai/*` 模块时按需挂载，并固定原始宿主原型引用以避免同进程连续执行多文件时重复包裹原型链；纯核心、状态、模板与界面单测不额外加载宿主后端包，隔离计算池也只在加载了 `isolated.ts` 的文件结束时按需释放。插件模型路由仍等实际创建 Agent 或处理 `agent/pre-step` 时动态加载，避免提前加载 `modelRoute -> presetAdapter` 使测试文件的 `vi.mock` 失效；`presetAdapterLegacy.test.ts` 与 `presetAdapterNewHost.test.ts` 覆盖缺失列表接口与扩展徽标等行为。异步等待只用于该事件分支，其它 waterfall 的返回类型（例如 `llm/stream` 的异步迭代器）保持原样。

`Test timed out` 只证明超过用例时限，不能直接认定业务回归或 runner 抖动。对比相邻用例耗时、上次同文件结果，并用相同平台单 worker 复跑。产品超时、WAL 持久化和隔离 worker 终止边界都必须保留。

## 发布与恢复

`scripts/release.mjs` 负责本地 Git/版本/CHANGELOG 守卫、版本提交及原子 push，不在本地跑完整测试；`--dry-run` 也只验证这些发布元数据。main CI 绿色仍是操作前提。tag workflow 会独立执行相同的双平台验证与 `main` 分支历史归属检查，防止手工 tag 绕过检查或发布非主分支提交。

Ubuntu verify 使用 `node scripts/verify-package.mjs`：`npm pack --ignore-scripts` 只打包一次，生成 tarball 和 SHA-256。只有整套检查成功后，release job 才下载**当前 workflow run、当前 SHA** 的 `npm-package-${{ github.sha }}`，重新校验 SHA-256，再上传同一份字节并输出包含标签、SHA 与校验和的发布摘要。下载后不安装依赖、重建或再次打包；对外校验附件仍叫 `SHA256SUMS.txt`。

发布 job 才拥有 `contents: write`；构建、依赖安装和测试只持有读取权限。checkout 不保留凭证。Actions 固定完整 commit SHA，使用 Node 24 运行时。

发布先创建 draft，上传附件成功后才公开：

- 上传失败：保留 draft，修复后重跑失败 job，在 draft 中补齐附件并公开。
- 验证阶段失败：不创建 Release；修复源码应使用新提交和新版本，不移动已经发布的 tag。
- 已公开 Release：下载现有 tarball 和校验和，逐字节相同才视为幂等成功；附件缺失或不同则失败，不覆盖公开文件。
- 当前 run 的包 artifact 已过期：完整重跑 tag workflow，重新完成验证后再发布，不从别的提交借包。

这些自动检查覆盖模拟宿主、真实临时文件系统及 CLI 交付，不替代宿主升级后的安装环境 boot/UI 冒烟；它们也不调用真实模型或读取用户剧情。

## 后续评估

`scripts/shard-tests.mjs` 记录了双平台主要重型套件的耗时基线，未登记的新增文件按特征与 SHA-1 稳定均衡分配；若后续新增大规模集成或沙箱压力套件，可根据最新的 `results.json` 补充基线权重。不要根据一次慢 runner 固定排除某个平台、只测变更文件或降低安全边界覆盖。

分片、Sequencer 与 reporter 使用当前锁定的 Vitest 4.1.12 API，并核对 [Vitest 分片说明](https://vitest.dev/guide/improving-performance.html)及 [GitHub 可复用 workflow](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)。
