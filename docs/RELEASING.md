# 发布包审核

CI 的 Ubuntu 全门禁会在构建、测试及 `lib/` 一致性检查完成后生成真实 npm tarball，并将 tarball 与对应的 SHA-256 文件一起上传为 `npm-package-<commit SHA>` artifact。

发布审核应以这份 artifact 为准：

1. 只接受目标提交的 CI 全部通过后产生的 artifact。
2. 下载并解压 artifact，使用 SHA-256 文件核对 tarball 内容未发生变化。
3. 检查包版本、变更记录及 `npm pack` 文件边界；确认两平台的 `doctor:check` 已通过，包含实际编译命令的直接入口、安装链接、JSON 输出和只读导入检查。
4. 后续发布流程直接发布已审核的 `.tgz`；不要再次运行 `npm pack`，否则审核对象与发布对象不再是同一份字节流。

当前仓库不会从 CI 自动发布到 npm。发布凭据及真正的 `npm publish` 应由单独、受保护的发布流程管理。
