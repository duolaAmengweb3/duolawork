# DuolaWork 3.0 对外文案与 90 秒真机演示脚本

日期：2026-11-27 · 对应基线：`DuolaWork 3.0.0`

---

## 一、官网 / GitHub 首屏 Hero 文案（中英双语）

### 中文主推版（独立开发者 / 一人公司 / 研发与产品团队）

> **DuolaWork 3.0 —— 自带订阅的多 Agent 桌面协作台（Multi-Model Cowork）**  
> **你已经买了 Codex、Claude、Gemini 和 Grok。别再为单一工作台交第二份“积分税”。**
>
> 把你本机和云端已有的 Coding Agent 与通用调研 Agent 请到同一张桌子上：  
> - **同对话无痛接力**：先让 Gemini 定清 Markdown 方案，左下角一键切到 Codex 基于定稿开独立 Git Worktree 写代码跑测试，底层仅传 12 KiB 有界增量，告别反复复制上下文。  
> - **负责人制定时任务**：一句话指派单次或循环任务，负责人自动拆单、派发、打回验收，单期失败绝不卡死下一期。  
> - **多标签精排阅读器**：Markdown（浅色 / 护眼 / 深色）、CSV 表格、JSON/JSONL、代码高亮、图片/PDF 全部在同一个独立多标签窗口并排审阅、改稿与版本防覆盖。  
> - **Local-First，零绑定锁死**：Mac 桌面端开箱即用本机 SQLite 免费运行，需要关机不停定时或手机同步时再可选连接云端控制面。

### English Hero Copy (GitHub README / Product Hunt / Landing Page)

> **DuolaWork 3.0 — The Multi-Model Cowork Workbench for Your Own AI Subscriptions**  
> **Stop paying credit markups on subscriptions you already own.**
>
> Put **Codex, Claude Code, Gemini, and Grok** on one desk across docs, code, data, and recurring automations:
> - **Relay Across Models in One Thread**: Draft and refine specs with Gemini, then switch the active owner to Codex in the same conversation with deterministic 12 KiB bounded delta handoff — it immediately reads the finalized spec and implements in an isolated git worktree.
> - **Manager-Reviewed Scheduled Runs**: Delegate one-off or recurring tracking in plain language. Your lead agent decomposes work, assigns isolated workers, reviews submissions, requests fixes automatically, and isolates each cron slot so one timeout never stalls tomorrow's run.
> - **Multi-Tab Editorial Reader**: Review Markdown specs (3 eye-care themes + outline), structured CSV tables, syntax-highlighted JSON/code, images, and PDFs side by side in one reusable popout workspace with conflict-safe versioning.
> - **Local-First Desktop + Optional Cloud Sync**: Zero login wall out of the box on macOS (`codex` / `claude` / `gemini` auto-discovered in 3 minutes). Connect your cloud control plane only when you want 24/7 headless schedules and cross-device sync.

---

## 二、为什么不是空白市场：竞品直接对比表

| 能力维度 | Claude Cowork | Manus / Lindy | OpenClaw / Paperclip | T3 Code | **DuolaWork 3.0** |
| --- | --- | --- | --- | --- | --- |
| **自带已有订阅 / 零积分抽税** | 仅 Anthropic 生态 | ❌ 黑盒积分/月费极贵 | ✅ | ✅ | **✅ 本地 CLI + 远端节点原生混编** |
| **Coding + 调研/文案同桌接力** | 偏桌面文件处理 | ❌ 偏一次性沙盒 | 偏脚本/重工单后台 | 仅写代码 | **✅ 12 KiB 有界增量无缝切换** |
| **负责人自动打回验收闭环** | ❌ 无多角色审校 | ❌ 黑盒长链难介入 | 部分需复杂配置 | ❌ | **✅ 内置确定性拆单-验收状态机** |
| **定时任务跨期隔离不堵队列** | 固定时钟，受限流 | 极易烧光积分 | 守护进程运维成本高 | ❌ | **✅ 每期独立会话，单期异常不卡下期** |
| **多标签精排文档/CSV/代码阅读器** | ❌ 单窗预览弱 | ❌ 仅报告卡片导出 | ❌ | ❌ 仅代码 Diff | **✅ 单窗口多标签 + 冲突分支版本** |

---

## 三、90 秒零模拟真机闭环演示分镜（实录规范）

> **拍摄铁律**：全程连接真实在线成员（如本机 `Codex` + `Gemini2VPS` / 本机 `Gemini` / `grok1`），严禁任何预制剧本或虚假输出；如需剪辑模型等待时间，必须在画面角标如实标注「实际耗时 XX 秒 · 加速剪辑」。

| 时间轴 | 画面内容 | 观众一眼看懂的爽点 |
| --- | --- | --- |
| **0:00 – 0:15** | 打开 **DuolaWork.app** → 展示首页空态 3 张场景卡，点「成员与用量」里的 **本机 Agent 一键发现**（检测出已装 `codex` / `claude` / `gemini`），点击 `一键接入` | **开箱即用，不锁模型、不买积分** |
| **0:15 – 0:35** | 回到 `+ 新对话`，点第一张场景卡「方案定稿 → 切人写代码」；当前成员先在右侧空间产出结构化 Markdown 方案 | **直接从一个需求起步，不是冷冰冰空框** |
| **0:35 – 0:55** | 点「独立窗口打开」，在 **多标签阅读器** 里调护眼/深色主题、切分屏直接手工修订一条要求，按 `⌘S` 保存到 `v2`；同时用 `+` 把同会话的 `.csv` 数据表也在第二个标签并排打开对照 | **文档 + CSV + 代码在一个多标签阅读窗口精排，不是原样吐文字** |
| **0:55 – 1:15** | 回到主对话，在底部直接把当前对接人切给 **Codex**，展示对话流里的**增量交接分隔条**，发一句「按刚才保存的 v2 方案实现」→ Codex 自动读到 v2 定稿与绑定目录开始改动并运行真实测试 | **换人不用复制粘贴 50 条记录，Coding Agent 直接沿最新定稿干活** |
| **1:15 – 1:30** | 点击顶部「指派任务」→ 点预设「竞品/行业周期追踪」切换到「循环定时」→ 触发跑一次真实跨成员步骤并验收交回交付卡；字幕落版 **DuolaWork 3.0 — Multi-Model BYOS Cowork** | **聊得清、写得完、定时跑得稳、改稿不丢版本** |
