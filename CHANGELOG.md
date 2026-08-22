# 更新日志

本插件与 dsh 宿主版本一一绑定（peerDependency 锁定精确版本），升级 dsh 前请先确认有适配的插件版本。

## 0.1.1（2026-08-22）

首个记录版本，适配 dsh `0.1.1-rc.2`。

- 角色卡（SillyTavern V1/V2/V3，PNG/JSON）导入导出；多开场白 swipe、卡内嵌世界书、`regex_scripts` 正则脚本、沙箱 iframe 交互卡封面。
- 提示词预设按 Prompt Manager 语义组装，经 dsh system-prompt 瀑布下发：常驻段进 standing（按会话 × 生成场景钉死），每轮变化进 runtime context。
- 世界书全局 / 角色 / 会话三级 + 变化层；常驻条目进 standing，关键词条目按轮检索，模型可经工具按条补读。
- BM25 长期记忆：时间衰减检索、超容量 idle 期异步压缩，配 7 个模型工具供多步 agent 循环按需调用。
- 楼层事务：写入走 WAL 可回滚；重新生成 / 回退 / 编辑 = fork 分支会话续跑，同层分支 ‹ n/m › 导航；另有不改历史的续写与 AI 代答。
- 人设（`{{user}}`）、分组条目、分组拦截顺序等 ST 语义对齐。
