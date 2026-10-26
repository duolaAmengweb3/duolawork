# 支持的 Agent（调研结果）

- 日期：2026-10-26
- 方法：先摸底，再逐家对照官方文档。**"官方确认"= 读过官方页面原文；"第三方"= 只有博客、教程或评测的说法；"你确认"= 你在自己账号里确认过。**

## 关键结论

**工作台用的是标准 MCP，所以只要一个 Agent 支持"添加自定义 MCP"，它就能直接接进来，不用为它单独开发。** 每多支持一家，要做的只有两件事：
1. 写一份接入指引（在那个 App 里点哪里、粘贴什么）；
2. 确定怎么叫醒它（webhook、Slack、邮件，或者只能靠它自己定时来查）。

---

## 第一档：能接，而且有官方依据（或你已确认）

| Agent | 能接吗（自定义 MCP） | 能被什么叫醒 | 主要限制 | 依据 |
|---|---|---|---|---|
| **Grok Bot**（xAI，由 Cursor 提供） | 你确认能加 | 定时（最短 5 分钟）、Slack、**webhook**（官方确认） | 长时间不理会，定时任务会被暂停 | 官方 + 你确认 |
| **ChatGPT Dots**（OpenAI） | 你确认能加 | 定时；Slack 里 @它（第三方） | 官方帮助页打不开，叫醒方式待实测；Pro、Business Premium 才有 | 你确认 + 第三方 |
| **Gemini Tasks**（原 Spark，Google） | 官方确认（已连接应用 → 自定义应用） | 定时（最短每小时）、Gmail 邮件触发、话题触发 | **写入必须手动确认**；仅美国、英文；需 AI Pro / Ultra；时间不精确 | 官方 |
| **Perplexity Computer** | **官方确认**：Pro、Max、企业版都能"填 MCP 地址添加自定义连接器"，支持 OAuth、API Key 或无认证 | 能定时运行（"recurring workflows"）；企业版能在 Slack 里被私信、被 @ | 个人版的 Slack 触发未确认；Personal Computer（本地版）还在候补名单 | 官方 |
| **腾讯 WorkBuddy** | **官方确认**：连接器页面右上角"自定义连接器"，"配置方式与 MCP 配置类似" | 定时自动化（第三方教程） | 写入类操作"需您明确指令确认"；个人版 / 企业版是否都有，官方没写 | 官方 + 第三方 |
| **千问办公 QwenWork**（阿里） | 第三方教程：连接器页有"自定义 MCP"；官方页面写了定时任务"可以调用 MCP 工具、使用连接器" | 定时任务（不重复、间隔、每小时、每天、每周、每月） | **定时任务由电脑客户端调度，电脑睡眠或关机就不执行**；每次执行消耗 Credits | 官方（定时）+ 第三方（自定义 MCP） |
| **OpenClaw**（开源，自己部署） | 能配置 MCP 服务器 | 自带 cron 定时（例子里有每 90 秒）；运行完能往外发 webhook | 需要自己部署和维护；"从外部用 webhook 叫醒"官方页面没写清 | 官方（定时）+ 第三方（MCP） |
| **Hermes Agent**（Nous Research，开源） | 支持 MCP（第三方指南） | 自带 cron（网关每 60 秒检查一次）；事件钩子 | 需要自己部署 | 官方（钩子）+ 第三方 |

## 第二档：大概率能接，但官方没写清，需要实测

| Agent | 情况 | 依据 |
|---|---|---|
| **Meta Muse** | 官方确认能让 Muse 自己搭"自定义连接器"（通过对方的 API）；官方没提 MCP。工作台给它准备普通接口 | 官方 + 第三方 |
| **豆包工作**（字节） | 第三方教程：「技能 · 连接器 · 伙伴」里能新建自定义连接器（名称、传输类型、地址、请求头）；**只能在电脑版用**；定时任务也只在电脑版 | 第三方，没找到官方帮助页 |
| **Kimi**（月之暗面） | Kimi Code 命令行工具支持 MCP 和定时任务；Kimi Agent（网页版）官方页面没提自定义 MCP | 官方 |

## 第三档：目前接不了

| Agent | 原因 | 依据 |
|---|---|---|
| **Instinct** | 只能用短信或电话找它；**没有公开的接口、没有 MCP**，多个来源一致；只能邀请加入 | 第三方（多方一致） |
| **Microsoft Copilot（Cowork）** | 个人版还在预览；没找到自定义 MCP 的资料 | 没找到依据 |
| **智谱 AutoGLM** | 定时任务官方说"即将上线"，自定义 MCP 没找到官方说明 | 没找到依据 |

## 不做（你的决定）

| Agent | 说明 |
|---|---|
| **Claude Duet**（Anthropic） | 2026-10-26 你决定不做。调研记录保留：官方页面写了"能用 6000 多个连接器和插件"，没提自定义连接器；有早期评测说它的定时运行用不了自定义连接器；仅美国 Pro、Max，候补名单 |

---

## 对产品的影响

1. **第一版仍然先做你手上的四家**，但工作台按"任何支持 MCP 的 Agent 都能接"来设计，不为某一家写死。
2. **"成员"页面要能选更多平台**：每个平台一份接入指引、一个默认的叫醒方式、一段限制说明。第一档的平台在第一版就给出接入指引。
3. **国内的三家（千问办公、豆包工作、WorkBuddy）都是电脑客户端**：它们只能靠自己的定时任务来查，而且电脑要开着。工作台要在成员页面明确提示这一点。
4. **对第三档，工作台不做接入**，在添加成员时如实标"暂不支持"，以及原因。

## 来源

官方：
- [xAI：Grok Bot 技能和定时任务](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Google：Gemini Tasks](https://support.google.com/gemini/answer/17094507?hl=en)、[Google：自定义应用](https://support.google.com/gemini/answer/17209137)
- [Perplexity：3 月 13 日更新（自定义 MCP 连接器、Slack）](https://www.perplexity.ai/changelog/what-we-shipped---march-13-2026)
- [腾讯云：WorkBuddy 连接器](https://cloud.tencent.com/document/product/1831/134525)
- [阿里云：千问办公定时任务](https://help.aliyun.com/zh/qwenwork/qwenwork-scheduled-tasks-desktop)
- [OpenClaw：定时自动化](https://docs.openclaw.ai/cli/cron)、[OpenClaw：MCP 事件](https://docs.openclaw.ai/automation/mcp-events)
- [Hermes Agent：事件钩子](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks)
- [Meta：Muse 连接器](https://www.meta.com/help/artificial-intelligence/1687253048996149/)
- [Anthropic：Claude Duet](https://claude.com/product/claude-duet)
- [Kimi：Agent 概览](https://www.kimi.ai/help/agent/agent-overview)、[Kimi Code 更新日志](https://www.kimi.com/code/docs/kimi-code/whats-new.html)

第三方：
- [Bland：Instinct 集成说明](https://docs.bland.ai/integrations/mcp/instinct)、[Crosswalk：Instinct](https://crosswalk.to/agents/instinct/personal-agent-protocol)、[CellCog：Instinct 是什么](https://cellcog.ai/blog/what-is-instinct-ai/)
- [Superpower Daily：Duet 定时运行用不了自定义连接器](https://superpowerdaily.com/posts/anthropic-opens-claude-duet-preview-for-ai-work-that-keeps-going-between-chats)
- [千问办公小绿书：连接器与 MCP](https://qwenwork.org/docs/features/connector-pages)
- [腾讯云社区：WorkBuddy 使用 MCP](https://developer.cloud.tencent.com/article/2698011)
- [知乎：豆包工作的连接器和 MCP](https://zhuanlan.zhihu.com/p/2083071595309015063)、[知乎：豆包定时任务](https://zhuanlan.zhihu.com/p/2075621426086801506)
- [Apidog：Hermes 与 OpenClaw](https://apidog.com/blog/hermes-agent-vs-openclaw/)
- [IT 之家：AutoGLM 2.0](https://www.ithome.com/0/876/731.htm)
- [Eesel：Perplexity Comet 价格](https://www.eesel.ai/blog/perplexity-comet-pricing)
