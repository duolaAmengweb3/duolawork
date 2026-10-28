# AI 原型生成记录

工具：内置 image_gen（imagegen 技能），透明背景关闭。三张均为 AI 生成的界面效果图；后两张仅以前一张作为视觉风格参考。图中账号、新闻、出处、进度、绩效与耗时均为示例，不代表真实联测。

文件：01-recipe.png、02-project-group.png、03-delivery-feedback.png。原始生成文件保留，项目副本未做图像编辑。

## 02 项目群协作

```text
Use case: ui-mockup.
Create a polished high-fidelity Chinese macOS desktop productivity application screenshot, front-on full app viewport, landscape about 1920x1200, no physical computer, no decorative background or perspective. Product name "Agent Hub". It organizes the user's existing personal agents into project groups; do not make it a generic chatbot, kanban, terminal, AI company org chart or trading dashboard. Familiar Feishu/Lark information architecture with the refinement and restraint of a native Mac app; use our own simple geometric blue icon, not the Feishu logo.
Design system: warm white surfaces, very pale blue-gray sidebar, charcoal readable Chinese typography, confident indigo-blue selection and primary buttons, subtle teal for confirmations, thin separators, modest 10-14px radii, calm spacing, crisp outline icons. Chinese primary text should be large and legible, avoid faint gray body text. Proper dense working software, no enormous empty hero, no heavy shadows, no gradients or cartoon avatars. Agent identities use tasteful circular letter avatars with text names Grok, Perplexity, Dot, Muse. All metrics/statuses are fictional prototype examples, visibly label "原型预览 · 示例数据" in a small top bar.
Persistent left sidebar: Agent Hub logo, workspace "我的工作室", nav "项目群", "配方广场", "知识库", "成员", and lower-priority "目标" with a small "稍后" badge. Under projects show "每日 X 内容包". Bottom workspace profile and settings. Do not show API keys, MCP, tokens, OAuth, server config or other engineering jargon.
Render a real UI mockup, elegant layout, consistent padding, no annotations outside the app, no watermark, not a sketch. Prioritize accurate concise Chinese labels over tiny paragraphs.
SCREEN 2 — active project group collaboration, the main screen.
Three columns: left sidebar about 240px; spacious central group conversation about 920px; right information panel about 600px.
Top group header "每日 X 内容包", subtitle "3 位 Agent · 每天 08:00", a small status "正在查证", controls "本次运行" and "暂停". Beneath it a slim execution strip with "发现热点" checked, "资料查证" blue active, "写成稿" pending, "你来审核" pending.
Central chat must clearly show distinct speakers and real handoff:
User message "今天重点看 AI Agent 的实操案例，别堆发布新闻。"
Grok message "已整理 5 个候选，附原帖和讨论。"
A compact structured handoff embedded in the conversation: "Grok → Perplexity", "5 个候选 · 12 条来源", small "材料已交接".
Perplexity message "正在核对第 3 个案例的原始资料。" with a modest progress row "来源核对 3/5".
Dot message "查证完成后，我会写出 3 条成稿，并保留出处。" with subtle "等待材料".
Bottom fixed composer placeholder "@成员补充要求，或添加资料…" with attachment icon and blue send button. No fake chain-of-thought; just brief work updates.
Right panel four readable tabs "成果" selected, "成员", "项目知识", "设置". Panel title "今日内容包", small status "准备中". Show "候选选题 5" and three compact rows, such as "Agent 开始互相派活了", "一个人如何组织多个助手", "从提示词到长期工作流". A clear output placeholder "查证完成后生成 3 条成稿", not a completed article. At the bottom show project writing rules: "短句，先给判断", "保留原始来源", "不自动发布". Keep the screen realistic, usable and visually excellent.
```

## 01 配方起步

风格参考：02-project-group.png。

```text
Use case: ui-mockup.
Create a polished high-fidelity Chinese macOS desktop productivity application screenshot, front-on full app viewport, landscape about 1920x1200, no physical computer, no decorative background or perspective. Product name "Agent Hub". It organizes the user's existing personal agents into project groups; do not make it a generic chatbot, kanban, terminal, AI company org chart or trading dashboard. Familiar Feishu/Lark information architecture with the refinement and restraint of a native Mac app; use our own simple geometric blue icon, not the Feishu logo.
Design system: warm white surfaces, very pale blue-gray sidebar, charcoal readable Chinese typography, confident indigo-blue selection and primary buttons, subtle teal for confirmations, thin separators, modest 10-14px radii, calm spacing, crisp outline icons. Chinese primary text should be large and legible, avoid faint gray body text. Proper dense working software, no enormous empty hero, no heavy shadows, no gradients or cartoon avatars. Agent identities use tasteful circular letter avatars with text names Grok, Perplexity, Dot, Muse. All metrics/statuses are fictional prototype examples, visibly label "原型预览 · 示例数据" in a small top bar.
Persistent left sidebar: Agent Hub logo, workspace "我的工作室", nav "项目群", "配方广场", "知识库", "成员", and lower-priority "目标" with a small "稍后" badge. Under projects show "每日 X 内容包". Bottom workspace profile and settings. Do not show API keys, MCP, tokens, OAuth, server config or other engineering jargon.
Render a real UI mockup, elegant layout, consistent padding, no annotations outside the app, no watermark, not a sketch. Prioritize accurate concise Chinese labels over tiny paragraphs.
Input image 1: STYLE REFERENCE ONLY. Generate a NEW screen in exactly the same Agent Hub design system: same logo, sidebar width, typography, blue palette and Mac titlebar as the reference.
SCREEN 1 — recipe entry and team setup. "配方广场" is selected in the left sidebar. This is an actual desktop app screen, not a website landing page. In the main area headline "从一个配方开始", subheading "选一件想做成的事，Agent 会在项目群里接力完成。"
First release has ONE usable recipe. Do not invent many active recipes or a huge marketplace.
A wide refined primary recipe card with a small "推荐配方" label, title "每日 X 内容包", description "5 个选题 · 3 条成稿 · 每条附来源". Show the compact workflow "发现热点 → 资料查证 → 写成稿 → 你来审核". Three short meaningful benefits: "保留原始出处", "在群里随时补充", "默认不发布". A prominent blue button "使用配方".
Beside the card, a well-composed setup/preview panel "项目群将包含" showing roles mapped to existing personal agents:
"热点发现" / "Grok" / "已连接";
"资料查证" / "Perplexity" / "待授权";
"写作与编辑" / "Dot" / "已连接".
Each has a small dropdown to change assignment; helper text "也可选择 Muse，按实际能力分工". A compact rhythm row "每天 08:00", with "先试跑，再开启自动运行". Missing connection is a clean guided step labeled "连接 Perplexity", not a technical config form.
Under these panels show a single restrained preview strip "第一次，你会得到什么" with three sample draft thumbnails represented by clean text blocks and small source-link icons, not actual photos. No fake KPI charts. Adequate density, striking clarity and natural spacing. Important Chinese words must be accurate and legible.
```

## 03 成果与反馈

风格参考：02-project-group.png。

```text
Use case: ui-mockup.
Create a polished high-fidelity Chinese macOS desktop productivity application screenshot, front-on full app viewport, landscape about 1920x1200, no physical computer, no decorative background or perspective. Product name "Agent Hub". It organizes the user's existing personal agents into project groups; do not make it a generic chatbot, kanban, terminal, AI company org chart or trading dashboard. Familiar Feishu/Lark information architecture with the refinement and restraint of a native Mac app; use our own simple geometric blue icon, not the Feishu logo.
Design system: warm white surfaces, very pale blue-gray sidebar, charcoal readable Chinese typography, confident indigo-blue selection and primary buttons, subtle teal for confirmations, thin separators, modest 10-14px radii, calm spacing, crisp outline icons. Chinese primary text should be large and legible, avoid faint gray body text. Proper dense working software, no enormous empty hero, no heavy shadows, no gradients or cartoon avatars. Agent identities use tasteful circular letter avatars with text names Grok, Perplexity, Dot, Muse. All metrics/statuses are fictional prototype examples, visibly label "原型预览 · 示例数据" in a small top bar.
Persistent left sidebar: Agent Hub logo, workspace "我的工作室", nav "项目群", "配方广场", "知识库", "成员", and lower-priority "目标" with a small "稍后" badge. Under projects show "每日 X 内容包". Bottom workspace profile and settings. Do not show API keys, MCP, tokens, OAuth, server config or other engineering jargon.
Render a real UI mockup, elegant layout, consistent padding, no annotations outside the app, no watermark, not a sketch. Prioritize accurate concise Chinese labels over tiny paragraphs.
Input image 1: STYLE REFERENCE ONLY. Generate a NEW later state of exactly the same Agent Hub project screen. Same logo, navigation, project name, avatars, typography and colors as the reference.
SCREEN 3 — completed deliverables, human editing and approval-based learning.
"项目群" selected, "每日 X 内容包" open. Header status "已交付 · 等你审核". Keep center group conversation and right work area, but make right editor a little wider, the main visual focus.
Center chat has Grok "来源已整理，5 个选题均附原帖。", Perplexity "已完成查证，出处已写入成稿。", a concise handoff "Perplexity → Dot · 查证资料已交接", then Dot "3 条成稿已交付。可以直接修改，或 @我继续调整。".
Show user feedback bubble "第二条开头太像新闻，换成实操角度。", and Dot reply "已更新第 2 条，其余内容保留。".
Right panel tabs "成果" selected, "成员", "项目知识", "设置". Editor title "今日 X 内容包", subtitle "版本 3 · 你的修改已保存", light formatting toolbar B I link, document selectors "成稿" "来源" "修改记录".
A clean editable-looking document with a readable heading "01 让 Agent 互相派活，卡在哪？" and short paragraphs:
"能传话，只是开始。"
"真正难的是：谁接任务、怎么交结果，中断后还能不能继续。"
"看一个工具，先看它能不能把这件事做完整。"
Small linked source chips "来源 1" "来源 2". Beneath show compact second and third draft headings.
In a separate fixed footer label "这份原稿，你怎么用了？" with FOUR clear choices "直接使用", "小改后使用", "重写后使用", "弃用". Tiny plain explanation "只记录反馈，不会发布到 X".
Below the document or in a compact bottom card show learning proposal, not an auto-applied rule: title "从这次改稿学到", proposed rule "开头先讲实操场景，少用发布新闻的口吻。", controls "加入项目知识" and "暂不". Mark it "待你批准".
Show a subtle compact group performance snippet somewhere appropriate "最近 7 天 · 采纳 10/14 · 待反馈 3", clearly example data. Do not imply copy or export equals adoption. No giant analytics dashboard. Make the UI premium, readable and usable.
```
