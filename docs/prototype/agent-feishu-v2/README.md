# Agent Hub v1 · 可点击原型

2026-10-30 · Codex。依据 Claude v1 定稿（93292dd）与 [#17 的 13 项评审](https://github.com/duolaAmengweb3/agent-hub/issues/17#issuecomment-6516376826)，在 PR #13 的 React/Tiptap 原型上修改。

**本轮图片来自实际页面，不是 AI 生图。** 这是本机 UI 原型，尚未连接真实 Agent，未替换正式桌面客户端。

## 打开

本机：<http://127.0.0.1:8873/>，也可直接打开 index.html。无 CDN 依赖。浏览器保存键为 agent-hub-v1-ui-review-20261030，旧版预览数据保留。

依赖已安装时，在仓库运行：

    node docs/prototype/agent-feishu-v2/build.mjs
    python3 -m http.server 8873 --bind 127.0.0.1 --directory docs/prototype/agent-feishu-v2

## 13 项评审对应

| 项 | 本轮处理 |
|---|---|
| B1 | 标题下显示合格标准，展开每条检查者、段落与依据；不达标列缺口。人工改稿后原检查标为历史 |
| B2 | 始终显示“独立互证 0（多处引用 3）”，展开解释来源关系 |
| 1 | 底部“采用成果”和正文“采纳此方案”区分 |
| 2 | 仅顶部向导显示步骤，不在左栏重复 |
| 3 | Grok / Dot 显示示例信源，实际能力以账号授权为准 |
| 4 | 交付预览只有一句话，随交付形式变化 |
| 5 | 移除大段宣传标题 |
| 6 | 采用原文段落、保留成员与小节来源，防重复插入 |
| 7 | 工作稿自动保存，无重复按钮和虚构字数上限 |
| 8 | 每份独立交付各自显示自查 |
| 9 | SDK 等文案由代码生成，无生图错字 |
| 10 | 成果列表“用于新任务”、输入框“引用成果”，知识库不放成果入口 |
| 11 | 规则说明区分已带入、已符合、未确认，不能把注入当遵守 |

## 可操作路径

- 三步新建：目标、资料、安排、交付形式、合格标准、节奏；通用目标不会固定套硬件标准。已有项目可直接发消息，工作安排可调整。
- Grok 四步、Dot 三步的接入向导。通知送达、订阅、Agent 回复分开演示。**不输入真实密钥，不执行授权；完成只更新演示状态。**
- 项目示例可选正常、来源冲突、成员失败、部分达标，手动推进交接、自查及内部修订。失败提供重试缺失成员、接受部分成果、终止三个操作。
- 默认一份最终稿；并排模式保留独立答案，逐段采用原文到“我的工作稿”。
- 可编辑、复制、导出、原位采纳决定或撤回。返工携带全文和基准版本，候选返回先对比，不覆盖人工新修改。
- 跨项目成果列表支持标题/正文搜索、项目与状态筛选、审阅、引用指定版本。
- 规则与资料分开；规则可确认范围、改措辞、撤回、查看使用说明。已带入不等于结果已核验。

## 验证与截图

运行：

    node docs/prototype/agent-feishu-v2/verify-v1.mjs

**20 项隔离 UI 检查通过**，覆盖导航、两项阻塞意见、正文决定撤回、人工稿持久化与旧自查失效、返工冲突、逐段原文采用、成果引用、规则范围与撤回、Grok/Dot 步骤、通用目标、单人交付、失败三操作、部分交付及未达标、两种尺寸阅读区域，以及对比工作稿保存失败时的状态与内存保留。

无 JavaScript 错误，无对外 Agent 请求。证据和构建哈希：[checks.json](evidence/v1/checks.json)。旧 verify.mjs 和旧 evidence 属于 2.0 历史记录，本轮使用 verify-v1.mjs / evidence/v1。

| 页面 | 实际截图 |
|---|---|
| 项目过程 | [项目](evidence/v1/01-project.png)、[成员失败](evidence/v1/11-member-failure.png) |
| 成果自查 | [展开检查](evidence/v1/02-self-check.png)、[最终稿](evidence/v1/03-final-result.png)、[未达标](evidence/v1/12-partial-criteria.png) |
| 返工 | [候选冲突](evidence/v1/04-revision-conflict.png) |
| 对比 | [原文采用](evidence/v1/05-independent-comparison.png) |
| 积累 | [成果列表](evidence/v1/06-results.png)、[规则](evidence/v1/07-knowledge.png) |
| 接入 | [Grok](evidence/v1/08-grok-connect.png)、[Dot](evidence/v1/09-dot-connect.png) |
| 安排 | [安排](evidence/v1/10-arrangement.png) |
| 尺寸 | [1440](evidence/v1/review-1440.png)、[1280](evidence/v1/review-1280.png) |

## 正式接线仍需完成

状态、进度、自查、规则使用与来源记录均为本地示例。真实 MCP/webhook/Events、后台调度、两轮唤醒返工、服务端隔离与并发、模型语义核验仍须接后端联测。日程仅保存；“让团队安排”只演示等待语义；新消息不启动真实 Agent。

本轮未修改账号、钥匙串、浏览器资料、VPN、代理或云端服务。UI 检查不代表真实平台接通、内容质量已达标或整个 v1 已交付；视觉观感仍待所有者评审。
