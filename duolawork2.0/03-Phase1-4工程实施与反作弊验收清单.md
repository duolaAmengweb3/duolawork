# 03 - DuolaWork 2.0 分阶段施工单与反作弊硬验收标准（供执行 Agent 施工）

> **阅读对象**：负责编码落地的工程师 / Codex Agent，以及负责最终把关的验收方。  
> **前置必读**：[README.md](./README.md)（产品定义与入口关系） + [02-开发架构与连接器选型方案.md](./02-开发架构与连接器选型方案.md)（架构与模块选型） + [prototype-v2.html](./prototype-v2.html)（界面布局与自然产品文案基线）。  
> **最高原则**：**在全新目录 `duolawork-2.0/`（或 `packages/v2-*`）从零干净构建，严禁把 1.x 的群聊、`channel_turn`、轮询收件箱、内置旧连接器重新抄进来；外部连接器底座 `34号-DuolaBase 0.5.8` 已独立上线就绪，只读挂载即可，无需改动其代码；每完结一个阶段必须跑通真机实测并留存证据。**

---

## 第一章：7 条「一票否决」反作弊红线

1. **【严禁触碰禁区与破坏旧登录】**
   - 严禁删除、重置或覆盖 `~/.config/agent-hub/` 下的现有配置文件、密钥与专用 Chrome `profiles/<account_id>` 登录目录；2.0 必须只读继承/挂载已验证的本机运行端与登录态。
   - **严禁连接、探测或调用用户云端 VPS 上的订阅 Claude Code 实例**（历史铁律继续有效）。
2. **【零群聊残留铁律】**
   - 代码与 UI 中严禁出现“群聊 `@` 提及唤醒”“会议室”“全局秘书”“对话内并行分叉按钮”“`stay_silent` 静默回执回合”。
   - 正文提及任何 Agent 名称（如“一会儿让 Codex 看看”）仅作普通纯文本，后端不得解析 `@` 唤醒其他成员。
3. **【推式直驱、空闲零消耗与三层独立计量铁律】**
   - **消除纯收件通信轮**：用户在单线程发 1 条普通消息，工作台派发数（`workbenchDispatches`）与原生协议回合数（`nativeTurns`）严格等于 **`1`**，其余未选中成员严格为 **`0`**；平台实际模型请求与缓存/未缓存 Token（`providerUsage`）按真实回执单独记录（未暴露项标 `observable: false`，不混称或伪造）。
   - **空闲零消耗**：无活跃对话与未到 Cron 触发点时，严禁周期性唤醒模型查收件箱；静置期间工作台模型派发数严格等于 **`0`**。
4. **【任务会话隔离、最小权限沙盒与防覆盖铁律】**
   - 每个 `TaskStep` 绑定独立工作会话（对无多会话能力的固定 Bot 强制 `maxConcurrentRuns=1` 串行隔离）；每次执行签发短期 `scopedTurnToken`，服务端硬拦截 Worker 调负责人接口、跨任务读产物及未授权的 DuolaBase 写/明文密钥操作（返回 `403`）。
   - 切人后任务核验仍归属当期 `task.lead_member_id` 独立统筹会话；文稿写入强制校验 `expectedBaseVersion`，旧回合晚交自动落入 `conflict_branch`，绝不覆盖人类或新负责人的最新稿。
5. **【零内置业务连接器铁律】**
   - DuolaWork 2.0 仓库内 **0 行** GitHub / Gmail / 飞书 / 微信业务 API 胶水代码；外部工具与共享凭证统一通过给受管 Agent 挂载独立的 **DuolaBase `/mcp`** 解决。
6. **【2026 现代前端与纯净产品文案铁律】**
   - 采用 React 19 + Tailwind CSS v4 + `lucide-react`；**全仓 0 个原生 `<select>`、`<details>`、`<datalist>`**；支持深浅双主题；生产构建 JS gzip `< 180 KB`。
   - **唯一对话入口与去工程黑话**：顶部新建入口永远只有一个 **`+ 新对话`**，严禁拆出“线性对话 / 任务对话”两个聊天入口（任务从对话内自然立项，左侧「任务」仅为进度与定时看板）；**前端界面严禁出现任何架构说教或旧版纠错文案**（如“仅唤醒 1 人”“线性单主线”“静置空耗 0”“防堵死”“物理隔离”“不含闲聊”等内部术语一律不得上屏）。
7. **【真多端实测铁律（拒绝纯 Mock 交差）】**
   - 单测 Mock 不能代替真实运行端验收。最终验收必须使用本机真实的 **Codex** + **Antigravity (Gemini)**（及已配置的 **Grok Bot** 如在线）跑通真实切换接力与任务派发验货闭环，留存真实运行日志与页面实拍图。

---

## 第二章：Phase 1 ~ Phase 4 可执行施工拆解表

### Phase 1：干净底座 + 三大标准 `AgentDriver`（砍掉 55 个旧本地脚本）
| 编号 | 模块与目标文件 | 核心实现要求 | 阶段完成标准（DoD） |
| --- | --- | --- | --- |
| **P1-01** | Monorepo 与单 SQLite 状态库<br>`duolawork-2.0/packages/{shared,server}/src/db.ts` | 初始化 Node 24 + TypeScript + Hono + `node:sqlite`（WAL 模式）；建好 `v2_members`、`v2_threads`、`v2_thread_messages`、`v2_handoff_cursors`、`v2_tasks`、`v2_task_runs`、`v2_task_steps`、`v2_artifacts` 表。 | `npm run typecheck` 0 报错；启动后单库自动建表与迁移幂等。 |
| **P1-02** | 统一 `AgentDriver` 抽象与本机账号无损识别<br>`packages/server/src/drivers/{types,registry}.ts` | 定义 `checkHealth / ensureSession / runTurn / abortTurn` 标准接口；安全只读探测本机已登录的 Codex、Antigravity 与既有成员配置（不写坏旧目录）。 | 健康检查准确区分 `ready / offline / auth_required`，不伪造在线状态。 |
| **P1-03** | `CodexDriver`（官方 App Server 直驱）<br>`packages/server/src/drivers/codex-driver.ts` | 通过 JSON-RPC 驱动 `codex app-server`（`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`），流式回传工具动态与最终回复。 | 真机发 1 句指令 → 精确 1 次原生 turn 完成并拿回结构化文本与 token 用量。 |
| **P1-04** | `AcpDriver`（标准 ACP 协议直驱）<br>`packages/server/src/drivers/acp-driver.ts` | 基于标准 ACP JSON-RPC over stdio 驱动 Antigravity / Gemini（及兼容 ACP 的运行端），通过 `session/new`、`session/load`、`session/prompt` 完成单轮直推与 `Stop` 收尾。 | 真机发 1 句指令 → 精确 1 次原生回合返回，无 ANSI 乱码抓取。 |
| **P1-05** | `WebhookBotDriver`（异步个人 Bot 驱动）<br>`packages/server/src/drivers/webhook-bot-driver.ts` | 适配 Grok Routine 等 Webhook 触发型 Agent：POST 任务载荷 + 绑定单次 `turnToken` 回调接口落库，支持超时状态标记。 | 隔离测试验证：正常回调落库、重复回调幂等、伪造 Token 403 拒绝。 |

---

### Phase 2：方式一 —— T3 Code 式「单线程切换负责人」+ 右侧成果空间
| 编号 | 模块与目标文件 | 核心实现要求 | 阶段完成标准（DoD） |
| --- | --- | --- | --- |
| **P2-01** | 单线程排他寻址与 SSE 实时流<br>`packages/server/src/threads.ts` | `POST /api/v2/threads/:id/messages` 严格只投递给 `active_owner_member_id`；通过 SSE 实时推送流式输出与回合状态。 | 发消息给 A 时，B/C 驱动器调用次数严格为 `0`；正文写 `@B` 也不触发 B。 |
| **P2-02** | 负责人切换与 `Delta Context Handoff`<br>`packages/server/src/handoff.ts` | 切换 `active_owner_member_id` 后首次发言，自动对比该成员 `last_seen_seq`，确定性拼装增量用户原话、前任结论摘要及右侧最新成果版本引用（`<context_handoff>`），零额外大模型调用。 | `A -> B -> A` 真机实测：B 准确拿到 A 的方案落地，切回 A 准确读到 B 的产出，全程零人工复制粘贴。 |
| **P2-03** | 在途切换保护与取消机制<br>`packages/server/src/threads.ts` | A 仍在执行时切到 B：不阻塞给 B 发新消息；A 迟到完成的输出严格写回 A 原消息卡，不篡改当前 `active_owner_member_id`。 | 并发切换集成测试 100% 通过。 |
| **P2-04** | 右侧可编辑成果库与 Git Worktree 管理<br>`packages/server/src/artifacts.ts`, `worktrees.ts` | 文稿/产物保存版本历史（区分 Agent 原稿与人类改稿）；人类改稿后发消息自动附带最新版本指针；代码项目支持按 Thread / Step 创建隔离 `git worktree`。 | 人类编辑保存刷新不丢；Agent 下一轮准确读取人类修改后的新版本。 |

---

### Phase 3：方式二 —— 负责人统筹的「任务制协作」（单次 + 定时长期）
| 编号 | 模块与目标文件 | 核心实现要求 | 阶段完成标准（DoD） |
| --- | --- | --- | --- |
| **P3-01** | 确定性任务有限状态机（FSM）<br>`packages/server/src/tasks-fsm.ts` | 实现 `Task -> TaskRun -> TaskStep` 状态流转：`pending -> running -> submitted -> (Lead Review) -> changes_requested / accepted -> completed`；强制校验前置 `dependsOn` 全部 `accepted` 后才解锁下游 Step。 | 状态机全分支单测覆盖：依赖解锁、非法越权改状态拦截、幂等提交。 |
| **P3-02** | 负责人（Lead）与执行人（Worker）工具分离挂载<br>`packages/server/src/task-mcp.ts` | Lead 会话挂载 `task_create_or_update / task_review_step / task_complete_run`；Worker 独立会话仅注入本步 Brief + `step_submit_result`，物理屏蔽派单与群聊能力。 | Worker 尝试调用 Lead 工具直接 403 或不可见；Worker 上下文不含主对话历史。 |
| **P3-03** | 自动跟进与打回返工熔断闭环<br>`packages/server/src/tasks-runner.ts` | Worker 提交后自动拉起 Lead 核验；Lead 返回 `changes_requested` 自动拉起原 Worker 在同一任务会话返工；超过 `maxReviewRounds`（默认 3 轮）自动熔断标为 `waiting_user` 上报主对话。 | 模拟第 1 版缺项被打回 → 第 2 版补齐通过 → Lead 汇总推回主对话交付卡全自动跑通。 |
| **P3-04** | 定时长期任务调度器（跨期防堵死）<br>`packages/server/src/scheduler.ts` | 解析 Cron / 固定周期计划，每次触发创建全新 `TaskRun #N` 及全新独立 Step 会话；上一期 `Run #(N-1)` 若仍在超时/失败态，仅标记该期异常，**绝不阻塞 `Run #N` 按时启动**。 | 实测 `Run #1` 人为挂起超时，`Run #2` 到点正常创建、执行并交付成功。 |

---

### Phase 4：2026 高质感三栏工作台前端与真机总验收
| 编号 | 模块与目标文件 | 核心实现要求 | 阶段完成标准（DoD） |
| --- | --- | --- | --- |
| **P4-01** | 三栏工作台与对话页（唯一对话入口）<br>`packages/web/src/components/{Sidebar,ThreadView}.tsx` | 左栏（唯一 `+ 新对话` 按钮、`对话` 列表、`任务` 后台看板、底部 `成员与连接`）；中栏自然对话流 + 左下角 `[Codex ▾]` 选择器 + 对话内嵌任务卡（点击可展开步骤详情）。 | 0 原生 `<select>/<details>`；全界面零工程纠偏黑话；深浅双主题丝滑；换人接手 ≤ 2 次点击。 |
| **P4-02** | 任务中心看板与步骤验收时间线抽屉<br>`packages/web/src/components/{TaskCenter,TaskDetail}.tsx` | 直观展示负责人（Lead）、各分工 Step 执行人（Assignee）、当前状态徽章、每版提交与负责人核验评语、以及长期任务的历次 `Run #N` 切换器。 | 一眼看清“谁负责统筹、谁在干哪步、卡在哪条核验意见”。 |
| **P4-03** | 右侧成果编辑器与 DuolaBase 一键联通<br>`packages/web/src/components/ArtifactWorkspace.tsx` | Markdown 预览/源码编辑、版本对比、一键交回当前负责人；成员设置支持一键开启 DuolaBase `/mcp` 共享凭证与连接器注入。 | 编辑、导出、版本切换与 DuolaBase 工具调用端到端打通。 |
| **P4-04** | Playwright UI 验收 + 真机双端闭环归档<br>`tests/e2e-ui.test.ts`, `evidence/v2-final/` | 跑完自动化回归、Playwright 桌面/窄屏截图与真实 `Gemini + Codex` 双端切换 + 任务拆单验货实录。 | 产出完整 `evidence/v2-final/README.md` 与截图证据包。 |

---

## 第三章：硬验收打勾总表（DW2-01 ~ DW2-12）

| 编号 | 验收项 | 客观判定指标（不达标直接打回） |
| --- | --- | --- |
| **DW2-01** | 全量类型与自动化测试 | `npm run typecheck && npm test` 100% 通过，0 失败，0 skipped。 |
| **DW2-02** | 登录与历史资料无损 | `~/.config/agent-hub/` 原有文件与 Chrome `profiles` 完整保留；VPS Claude 未被触碰。 |
| **DW2-03** | 单线程排他与三层计量对账 | 发 1 条普通消息仅目标成员 `workbenchDispatches=1, nativeTurns=1`，其余成员 `0`；真实记录 `providerUsage` 而不伪造不可观测指标。 |
| **DW2-04** | 本机 + `Gemini2VPS` 跨机接力与断线恢复 | **首里程碑必测**：本机 `Codex` 与远端 `Gemini2VPS` 同对话接力 + 独立派工 + 中途断线重连对账恢复；超长历史交接 ≤ `12 KiB` 且离线失败不丢游标。 |
| **DW2-05** | 负责人拆单、固定 Bot 串行与非本人执行 | 负责人在需求敲定后建单指派其他成员执行；并发派给固定窗口 Bot 的两项任务按能力声明安全串行隔离、上下文不互串。 |
| **DW2-06** | 最小权限沙盒与跨任务隔离 | Worker 调负责人接口、跨任务读产物或默认只读策略下调外部写/明文密钥接口均 `403` 拒绝；关闭 DuolaBase 开关时主对话正常工作。 |
| **DW2-07** | 切人后核验归属、文稿防覆盖与唯一结单 | `A` 派单后切 `B` + 人工改稿 + 并发步骤提交 + `A` 旧回合晚归：核验归 `A` 统筹会话、人类新稿零覆盖、`waiting_user` 回复精准续跑、代码多 Worktree 合入集成分支通过测试、原对话仅生成唯一交付卡。 |
| **DW2-08** | 定时任务同槽去重、名额释放与单次交付 | `(task_id, planned_slot_at)` 重复触发零重跑；上一期超时立即释放成员执行名额，同一成员准点跑通下一期；迟到回执归档不二次交付。 |
| **DW2-09** | 静置零模型唤醒 | 系统挂机无操作、无到期 Cron 时，所有驱动器发起的模型派发数为 **`0`**。 |
| **DW2-10** | 1.x 无损共存、历史只读与一键回退 | 2.0 独立端口与独立 SQLite 运行，只读导入既有成员身份与 1.x 历史归档，不中断旧服务、不改写旧库，随时可回退。 |
| **DW2-11** | 2026 前端质量、唯一入口与纯净文案 | 唯一 `+ 新对话` 入口（不拆双聊天入口）；界面 0 工程纠偏黑话；源码 0 个 `<select>/<details>/<datalist>`；JS gzip `< 180 KB`；深浅双主题与右侧文稿编辑实拍过关。 |
| **DW2-12** | 零密钥泄漏与零临时垃圾 | 仓库、日志、SQLite 明文列与截图 0 密钥泄露；`/private/tmp/duolawork*` 测试临时目录清理归零。 |
