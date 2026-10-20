# 发布包审核

宿主兼容升级必须发布新的插件版本，不能只改 `main` 的依赖后继续推荐旧标签。提交前同步 `package.json`、锁文件、中英文 README 的插件版本、宿主徽标、安装标签和 tarball 文件名，补齐 CHANGELOG 与 `docs/releases/v<版本>.md`。旧标签与已发布附件保持不变。

CI 的 Ubuntu 全门禁会在构建、测试及 `lib/` 一致性检查完成后生成真实 npm tarball，并将 tarball 与对应的 SHA-256 文件一起上传为 `npm-package-<commit SHA>` artifact。

发布审核应以这份 artifact 为准：

1. 只接受目标提交的 CI 全部通过后产生的 artifact。
2. 下载并解压 artifact，使用 SHA-256 文件核对 tarball 内容未发生变化。
3. 检查包版本、变更记录及 `npm pack` 文件边界；确认两平台的全量 `npm audit`、`doctor:check` 已通过，包含实际编译命令的直接入口、安装链接、JSON 输出和只读导入检查。
4. 后续发布流程直接发布已审核的 `.tgz`；不要再次运行 `npm pack`，否则审核对象与发布对象不再是同一份字节流。

创建新标签时固定到已验证的完整提交 SHA。发布前用独立 `DSH_HOME` 安装待发布包，检查实际宿主启动、关于页版本与关键 UI；发布后再核对 `releases/latest`、标签中的 manifest、附件版本和 SHA-256，确保安装入口真正指向本次验证的版本。

当前仓库不会从 CI 自动发布到 npm。发布凭据及真正的 `npm publish` 应由单独、受保护的发布流程管理。
