# CI、测试与发布

## 检查顺序

`.github/workflows/ci.yml` 同时用于 main push、PR、手动运行和 Release 的 `workflow_call`。

1. `verify` 在 Ubuntu、Windows 分别安装锁定依赖，检查宿主版本、构建产物与预设资产，执行 doctor/backup 安装入口冒烟。Ubuntu 先用固定版本、固定 SHA-256 的 actionlint 检查两个 workflow，再执行一次 `npm audit --package-lock-only`，审计完整锁文件而非当前平台安装子集，生成真实 tarball 并验证发布白名单；Windows 验证直接调用 Node 脚本时的 `npm.cmd` 分支。
2. 两个平台的 verify 均成功后，启动四台独立 runner：每个平台各运行 `--shard=1/2` 和 `--shard=2/2`。每台 runner 内仍只跑一个 Vitest worker，两片合起来覆盖该平台的全部测试。测试直接使用刚由 verify 验证与源码一致的入库 `lib/`，不重复构建。
3. `CI checks` 汇总全部结果；失败、跳过或取消均不能通过。分支保护可选择这个稳定名称，原来的 `ubuntu-full` / `windows-core` 已替换。

分片通过增加独立机器缩短墙钟时间，会增加依赖安装次数；它不减少双平台测试覆盖，也不承诺减少总 runner 分钟数。不要把 QuickJS 的产品执行期限改大来适应并发竞争。单个集成测试确实包含多段文件系统事务时，可以说明理由后单独配置总时限。

同一分支或 PR 的新提交会取消旧 CI；Release 与复用的验证使用不同 concurrency 组，同一 tag 的发布不会互相取消。矩阵 `fail-fast: false`，一次失败仍能收集其它片的结果。

`.gitattributes` 将生成的 `lib/**/*.js` 与 `lib/**/*.d.ts` 固定为 LF，确保 Windows 首次检出与构建输出一致；固定检查点引擎仍由后置 `-text` 规则保留原始字节。不能只在已有工作区里重建验证：`buildCheckout.test.ts` 使用真实 Git 首次 clone，分别覆盖 `core.autocrlf=true/false`，并执行 workflow 的原始守卫，确认真实内容变动、缺失文件和未跟踪产物仍被拒绝。

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

复现 CI 的单 worker 与报告行为（PowerShell）：

```powershell
$env:CI = 'true'
$env:GITHUB_ACTIONS = 'true'
npm test -- --shard=1/2
node scripts/summarize-tests.mjs .vitest/results.json
```

POSIX shell：

```bash
CI=true GITHUB_ACTIONS=true npm test -- --shard=1/2
node scripts/summarize-tests.mjs .vitest/results.json
```

另一片改为 `--shard=2/2`。定位到某个文件后可直接 `npm test -- test/toolWriteReceipt.test.ts`。报告默认覆盖 `.vitest/results.json` 和 `.vitest/junit.xml`；连续本地运行需先复制想保留的报告，也可用 `--outputFile.json=.vitest/shard2.json --outputFile.junit=.vitest/shard2.xml` 指定独立输出。`.vitest/` 已被 Git 忽略。

正常全量运行不需要设置这些环境变量，仍使用原来的本地 worker 数与终端 reporter。没有统一重试；测试失败应保留，不能通过自动重跑隐藏。

## 失败诊断

每片的 Actions Summary 包含通过/失败/跳过计数、失败用例、失败文件以及耗时最高的十个文件和用例。即使测试失败，也上传 `test-results-<系统>-<分片>`，保留 14 天：

- `results.json`：包含测试结果、时间、断言与错误，可用于后续耗时比较。
- `junit.xml`：供 JUnit 工具读取，不重复附带全部 console 输出。

显式 reporter 列表保留 `github-actions`，失败仍能生成源代码注解。若测试进程在生成报告前崩溃，摘要和上传步骤明确失败，并保留此前的测试错误；不会输出一个空的成功摘要。

`Test timed out` 只证明超过用例时限，不能直接认定业务回归或 runner 抖动。对比相邻用例耗时、上次同文件结果，并用相同平台单 worker 复跑。产品超时、WAL 持久化和隔离 worker 终止边界都必须保留。

## 发布与恢复

`scripts/release.mjs` 负责本地 Git/版本/CHANGELOG 守卫、版本提交及原子 push，不在本地跑完整测试；`--dry-run` 也只验证这些发布元数据。main CI 绿色仍是操作前提。tag workflow 会独立执行相同的双平台验证，防止手工 tag 绕过检查。

Ubuntu verify 使用 `node scripts/verify-package.mjs`：`npm pack --ignore-scripts` 只打包一次，生成 tarball 和 SHA-256。只有整套检查成功后，release job 才下载**当前 workflow run、当前 SHA** 的 `npm-package-<SHA>`，重新校验 SHA-256，再上传同一份字节。下载后不安装依赖、重建或再次打包；对外校验附件仍叫 `SHA256SUMS.txt`。

发布 job 才拥有 `contents: write`；构建、依赖安装和测试只持有读取权限。checkout 不保留凭证。Actions 固定完整 commit SHA，使用 Node 24 运行时。

发布先创建 draft，上传附件成功后才公开：

- 上传失败：保留 draft，修复后重跑失败 job，在 draft 中补齐附件并公开。
- 验证阶段失败：不创建 Release；修复源码应使用新提交和新版本，不移动已经发布的 tag。
- 已公开 Release：下载现有 tarball 和校验和，逐字节相同才视为幂等成功；附件缺失或不同则失败，不覆盖公开文件。
- 当前 run 的包 artifact 已过期：完整重跑 tag workflow，重新完成验证后再发布，不从别的提交借包。

这些自动检查覆盖模拟宿主、真实临时文件系统及 CLI 交付，不替代宿主升级后的安装环境 boot/UI 冒烟；它们也不调用真实模型或读取用户剧情。

## 后续评估

先积累新分片的真实耗时，再决定是否需要按历史耗时定制调度。Vitest 自带分片按文件划分，测试数量相近不代表执行时间完全相等。不要根据一次慢 runner 固定排除某个平台、只测变更文件或降低安全边界覆盖。

分片与 reporter 使用当前锁定的 Vitest 4.1.12 API，并核对 [Vitest 分片说明](https://vitest.dev/guide/improving-performance.html)及 [GitHub 可复用 workflow](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)。
