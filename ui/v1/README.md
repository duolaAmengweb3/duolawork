# 正式 v1 界面

现成组件采用 [shadcn/ui New York v4 官方 registry](https://ui.shadcn.com/r/styles/new-york-v4/button.json)，配置见根目录 `components.json`；保留 [MIT 许可](components/ui/LICENSE.md)。组件基于 Radix，样式使用 Tailwind v4。文稿编辑使用 Tiptap，历史版本和候选通过真实后端读取。

`App.jsx` 是正式入口与页面编排，`Document.jsx` 为按需加载的文稿编辑器，`SelfCheck.jsx` 展示绑定版本的成员自查，`api.mjs` 只调用本机同源网关。管理密钥不进入前端。

主导航：项目、成果、待我决定、知识库、成员。桌面宽度 1440×900 和 1280×800 的操作证据为 `evidence/v1-ui-*.png`；截图数据来自隔离测试参与者，不是商业 Agent 的真实回答。

本地存储只保留当前视图、未发送输入和网络失败时的未保存副本；项目、稿件版本、决定、资料与规则以云端记录为准。正式入口不加载示例项目，不把旧浏览器登录状态当作 MCP 可接任务状态。
