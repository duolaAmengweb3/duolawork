# 独立协作服务

复用 `cloud/worker.ts` 的业务接口和数据库事务，在 Node.js 24+ 上运行。`sqlite.mjs` 只适配 D1 SQL 接口；群聊、MCP、OAuth、文档版本、领取和回执逻辑不另写一套。

## 构建与运行

```sh
node scripts/build-server.mjs
HUB_SERVER_CONFIG=/private/path/server.json node release/server/main.mjs
```

配置在仓库之外，权限 0600；不要提交真实密钥、数据库或导出内容。

```json
{
  "publicOrigin": "https://hub.example.com",
  "compatibleOrigins": ["https://previous.example.com"],
  "adminKey": "从原部署保留的管理与加密密钥",
  "gatewaySecret": "仅供旧入口与独立服务鉴别转发来源",
  "workspaceId": "owner",
  "database": "/var/lib/agent-hub/hub.sqlite",
  "port": 8787,
  "enableScheduled": true,
  "maxRequests": 128,
  "maxConnections": 256
}
```

应用只监听 loopback。HTTPS 入口使用 Nginx，必须覆盖 `X-Real-IP`，限制请求体和超时；不要把 loopback 端口暴露公网。独立系统用户运行，数据库与配置归该用户，systemd 管理启动和恢复。资源上限是单节点保护值，不代表已验证能同时服务同等数量的 Agent。

## 数据迁移与旧入口

1. 在独立数据库验证 HTTPS、鉴权、MCP、事务、文档冲突、并发写和重启恢复。
2. 核对原服务无执行中的工作。旧 Worker 设置 `HUB_MAINTENANCE=1` 暂停新访问和 cron，等已有长轮询及后台操作排空后导出 D1。
3. 校验 SQL、表记录数、完整性和账号/成员身份。停止候选服务，用快照建立生产 SQLite，保留原 `ADMIN_KEY`；否则旧密文无法解密。
4. 新节点启用原工作区和调度。Worker 设置 `HUB_RELAY_ORIGIN`、私有 `HUB_RELAY_SECRET`，解除维护；它只兼容转发旧地址，不再读写旧 D1，也不运行旧调度。
5. 旧 OAuth/MCP 地址必须保持原 origin，成员凭证及回调不能被改写。转发失败返回可重试错误，不自动回退旧 D1 写入，避免两份主数据。
6. 新入口直接使用独立域名，不消耗 Workers 请求额度；旧入口的兼容转发仍消耗 Workers 请求额度。迁移数据库并不自动取消这一部分用量。

**启用 VPS 后，`npm run hub:deploy` 已自动转到 `scripts/deploy-server.mjs`，避免只更新 Cloudflare、实际业务却不生效。** 部署目标保存在操作者私有的 `~/.config/agent-hub/server-deploy/target.json`，内容为 `ssh`（如 `deploy@server.example`）和 `origin`；SSH 使用操作者正常的认证，可用 `HUB_SSH_CONTROL` 复用已经授权的连接，不保存密码。底层直接运行 Wrangler 只会更新旧入口兼容层。

部署前检查 `/v2/active-work`；切换文件时等待任务空闲并优雅停止服务，保留配置与数据库。若新节点已经接收写入，回滚前必须同步最新数据库，不能直接把旧 D1 重新设为主库。

## 验证

```sh
node scripts/build-server.mjs
node --test tests/server-sqlite.test.mjs tests/relay.test.mjs
node tests/server-http.mjs
npm test
```

HTTP 验证创建独立临时数据库，覆盖真实 MCP transport、历史 origin、权限拒绝、并发写、文档版本冲突与进程重启。它验证后端协议，不冒充真实原生 Agent 或商业规模验收。

## 容量与备份

当前 SQLite 是单个主节点的数据存储，不能直接复制几个服务进程就声称水平扩容。先测持续读写、长轮询、文件量、数据库增长及内存；接近容量时升级节点或按独立工作区分片，单个繁忙空间需要进一步迁移数据库。文件服务和备份要与计算节点分离，跨机器数据库复制不是目录同步。

SQLite 必须用在线 backup 或停止写入后的快照备份，不能只拷贝活跃的 `.sqlite` 丢掉 WAL。机内备份便于误操作恢复，不能抵御 VPS 整机丢失；对外商业交付还需要异机备份与恢复演练、监控、工作区隔离以及商定的服务容量。

## DuolaWork 共享文件

新文件存于 `objectDirectory`，默认数据库同级 `objects/`；旧 `FILE_STORAGE=d1` 记录保留原读取方式。服务端默认 `fileLimit=134217728`、`spaceQuota=2147483648`，由私有配置覆盖。分块64KiB，完整文件流式校验后才提交版本；上传配额包含正在上传的预留量。七天前的未完成上传自动过期并释放预留量，已发布版本保留。

每日备份包含 `.sqlite.gz`、同时间戳 `.manifest.json` 和去重的 `backups/objects/`。清单记录原件大小与SHA256，备份创建时逐一校验。恢复时先解压数据库并检查 integrity_check，再按清单把所有对象复制到配置的对象目录并核对哈希，最后在原工作区密钥下启动。不要只复制SQLite。仍需异机保留备份才能抵御整机损坏。

共享资料不是多租户账号系统：当前独立实例仍由自己的工作区及凭证控制，不能把此管理凭证打包分发给陌生用户。
