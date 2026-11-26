# DuolaWork 2.0 工程实施与真机总验收归档（`v2-final`）

日期：2026-11-25 · 工程根目录：`/Users/duola/Desktop/Xduola/32号-Agent-Hub/duolawork2.0`

## 一、审计问题闭环与核心增强落地

对照 [04-方案审计.md](../../04-方案审计.md) 提出的 4 项优先缺口与 5 处验收盲区，已全部在设计与代码中完成闭环：

1. **本机与远端 VPS 成员协同 + 断线对账恢复**
   - `v2_members` 显式持久化成员位置与能力矩阵（`supportsIsolatedSessions / supportsSessionResume / supportsCancel / maxConcurrentRuns`）。
   - 四类驱动器（`CodexAppServerDriver` 本机直连、`AcpStdioDriver` 本机 ACP、`RemoteBridgeDriver` 远端 `Gemini2VPS` 零重装隔离桥接、`WebhookBotDriver` 针对无独立会话的固定窗口 Bot 强制 `maxConcurrentRuns = 1` 串行队列隔离）。
   - 所有派发先写 `v2_dispatch_attempts` 幂等账本；网络断线或服务重启后通过 `reconcileInFlightAttempts` 先向原会话/远端通道核对回执，避免二次调用模型或重复产生外部副作用。
2. **定时调度同槽去重、超时立即释放名额与单次交付**
   - `v2_task_runs` 强制 `UNIQUE(task_id, planned_slot_at)` + IANA 时区（默认 `Asia/Shanghai`）+ `misfire_policy`。
   - 当上一期步骤超时时立即将 `slot_held` 置 `0` 释放该成员并发名额，保证同一成员准点执行下一期；上一期迟到回执自动标记为 `late_ignored` 归档，绝不重复投递交付卡。
3. **受管会话最小权限沙盒与 DuolaBase 读写分级代理**
   - 每次执行签发短期 `scopedTurnToken`，服务端硬拦截执行人（Worker）调用建单/验收接口、读取主对话历史或跨任务读写文稿（均返回 `403`）。
   - 默认只读策略（`duolabase_readonly`）仅放行查询类工具，硬拦截 `vault_reveal` 与外部写操作（如发消息、新建外部文档）；关闭 DuolaBase 开关时外部连接器调用返回 `403`，主对话照常可用。
4. **切人后核验归属、文稿乐观锁防覆盖、多步唯一结单与 Worktree 集成合并**
   - 任务验收固定路由至 `task.lead_member_id` 的独立统筹会话 `lead_session_key`；`waiting_user` 卡片补充答复精准送回原任务负责人续跑。
   - 文稿写入强制校验 `expectedBaseVersion`：切人并改稿后，前任负责人的迟到旧回合写稿自动存入 `conflict_branch` 分支版本，主稿 `headVersion` 零覆盖。
   - 多步骤并发通过时经 SQLite `BEGIN IMMEDIATE` 事务 CAS（`steps_running -> lead_final_review`）保证唯一终审与唯一主对话交付卡；代码步骤各自在独立 `git worktree` 完成后自动加锁合入 Run 集成分支并跑通集成校验命令。
5. **三层独立计量与纯净单入口前端**
   - 独立记录 `workbenchDispatches`（工作台派发数）、`nativeTurns`（原生协议回合数）与 `providerUsage`（平台可观测请求数及缓存/未缓存 Token，不可观测项诚实标 `observable: false`）。
   - 唯一沟通入口 `+ 新对话`，源码 `0` 个原生 `<select>/<details>/<datalist>`，全界面 `0` 工程纠偏黑话，生产构建 JS gzip 仅 **`78.45 KB`**（远低于 `180 KB` 上限）。

---

## 二、硬验收标准逐项核对结果（`DW2-01 ~ DW2-12`）

| 编号 | 验收项 | 结果 | 证据文件 |
| --- | --- | --- | --- |
| **DW2-01** | 全量类型检查、生产构建与自动化测试 | **PASS**（`9/9` 通过，`0` 失败） | [build.txt](./build.txt) · [test-suite.txt](./test-suite.txt) |
| **DW2-02** | 登录与历史资料零破坏、排除 VPS Claude | **PASS**（`~/.config/agent-hub/` 受保护文件前后 SHA-256 逐字节一致，`ClaudeVPS` 0 触碰） | [live-cross-machine-report.json](./live-cross-machine-report.json) |
| **DW2-03** | 单线程排他寻址与三层计量对账 | **PASS**（正文含 `@` 不唤醒旁人，`workbenchDispatches=1, nativeTurns=1`） | [core-fsm-and-sandbox.test.ts](../../tests/core-fsm-and-sandbox.test.ts) |
| **DW2-04** | 本机 `Codex` + 远端 `Gemini2VPS` 跨机接力、12KiB 交接与断线对账 | **PASS**（真机 `Gemini2VPS` v2 → 本机 `Codex` 接棒 v3 → `Gemini2VPS` 模拟断线对账恢复 `DW2-RECONCILE-OK`） | [live-cross-machine-report.json](./live-cross-machine-report.json) · [live-console.txt](./live-console.txt) |
| **DW2-05** | 负责人跨机派工核验 & 固定窗口 Bot 串行隔离 | **PASS**（`Gemini2VPS` 统筹派单给本机 `Codex` 执行并自动验收结单；固定 Bot 并发严格 `maxConcurrentRuns=1`） | [live-cross-machine-report.json](./live-cross-machine-report.json) |
| **DW2-06** | 最小权限沙盒、跨任务隔离与连接器开关 | **PASS**（越权建单/跨任务读稿/未授权外部写与 `vault_reveal` 均 `403` 拦截；关闭连接器主对话正常） | [core-fsm-and-sandbox.test.ts](../../tests/core-fsm-and-sandbox.test.ts) |
| **DW2-07** | 切人后核验归属、文稿 `conflict_branch` 防覆盖与并行 Worktree 合并 | **PASS**（人类改稿零覆盖，并行 Worktree 合入集成分支跑通 `A+B===100` 校验，仅产出唯一交付卡） | [core-fsm-and-sandbox.test.ts](../../tests/core-fsm-and-sandbox.test.ts) |
| **DW2-08** | 定时任务同槽去重、超时释放名额与迟到回执忽略 | **PASS**（重复触发 0 重跑；旧期超时释放名额后同一成员准点跑通下一期；迟到回执标 `late_ignored`） | [core-fsm-and-sandbox.test.ts](../../tests/core-fsm-and-sandbox.test.ts) |
| **DW2-09** | 静置零模型唤醒 | **PASS**（无用户动作与无到期 Cron 时模型派发数为 `0`） | [core-fsm-and-sandbox.test.ts](../../tests/core-fsm-and-sandbox.test.ts) |
| **DW2-10** | 1.x 无损共存与一键回退 | **PASS**（独立端口 `8780` + 独立库 `duolawork-v2.sqlite`） | [index.ts](../../src/server/index.ts) |
| **DW2-11** | 2026 前端质量、唯一入口、深浅双主题与精准来源跳转 | **PASS**（JS gzip `78.45 KB`；浏览器 E2E 验证期次切换联动右侧文稿且「发回原对话继续改」精准返回原对话） | [workbench-dark.png](./workbench-dark.png) · [workbench-light.png](./workbench-light.png) |
| **DW2-12** | 零密钥泄漏与零临时垃圾残留 | **PASS**（远端临时桥接测试通道与 `/tmp/dw2-*` 均已清零） | [live-console.txt](./live-console.txt) |
