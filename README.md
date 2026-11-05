# Network Monitor

基于 Cloudflare 的网络监控系统，提供公网目标 Ping 监测、设备心跳监测和 Webhook 告警能力。

## 功能概览

- **网络监控**：配置多个监控目标、探测地区和检查参数，查看监控状态及历史测量结果。
- **全球探测**：通过 Globalping 发起全球网络探测并获取测量结果。
- **心跳监测**：支持多台设备主动上报心跳，监测设备在线状态和离线事件。
- **Webhook 告警**：针对监控状态变化和心跳设备状态变化发送通知，并记录通知结果。
- **监控详情**：查看 Ping 延时、丢包等历史数据及统计信息。
- **时区设置**：可配置管理界面使用的显示时区。

## 系统架构

| 组件 | 用途 | 项目文件或服务 |
|---|---|---|
| Cloudflare Pages | 托管管理界面 | `index.html` |
| Cloudflare Worker | 提供 API、监控调度、结果轮询及告警处理 | `work/work_v1.5.js` |
| Cloudflare D1 | 保存监控、测量、心跳和告警数据 | D1 绑定名：`DB` |
| Globalping | 提供全球网络探测能力 | 外部 API |
| Worker Cron Trigger | 定时运行后台监控任务 | `*/1 * * * *`（每分钟） |

## 部署

首次部署请按部署指南逐步操作：

**[Cloudflare 部署指南（新手版）](docs/CLOUDFLARE_DEPLOYMENT_GUIDE.md)**

全新 D1 数据库使用完整初始化 SQL：

**[database/schema.sql](database/schema.sql)**

该 SQL 面向新建的空白 D1 数据库，包含当前版本所需的业务表、字段、约束、索引及默认时区。全新部署时执行一次即可，不要在已有业务数据的数据库上重复执行。

## Worker 必需配置

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中配置以下三个 Secret：

| Secret | 用途 | 配置方式 |
|---|---|---|
| `GLOBALPING_TOKEN` | Globalping API Token | 从 Globalping 账户获取 |
| `MONITOR_API_KEY` | 管理 API 鉴权密钥 | 本地执行 `openssl rand -hex 32` 生成 |
| `HEARTBEAT_TOKEN_ENCRYPTION_KEY` | 心跳设备 Token 的 AES-256-GCM 加密密钥 | 本地执行 `openssl rand -base64 32` 生成 32 字节随机密钥的 Base64 编码 |

三个变量均应配置为 **Secret**，不要提交到代码仓库。特别是 `HEARTBEAT_TOKEN_ENCRYPTION_KEY`，部署并开始保存心跳设备 Token 后，不要随意更换或丢失，否则已有密文将无法解密。

## 心跳上报

心跳设备通过 GET 请求上报，无需额外 Header，也无需请求 Body。系统生成的完整心跳 URL 中包含设备 Token，应按密码妥善保管。

## 仓库结构

```text
.
├── index.html                         # 管理界面
├── work/
│   └── work_v1.5.js                   # Cloudflare Worker 后端
├── database/
│   └── schema.sql                     # 全量数据库初始化 SQL
├── migrations/                        # 历史数据库结构变更脚本
└── docs/
    └── CLOUDFLARE_DEPLOYMENT_GUIDE.md # 详细部署指南
```

## 重要部署说明

1. Pages 必须能够将管理界面的 `/api/*` 请求转发到对应 Worker。
2. Worker 必须绑定 D1，绑定变量名为 `DB`。
3. Worker 必须配置上述三个 Secret。
4. Worker Cron Trigger 使用 `*/1 * * * *`，即每分钟执行一次。
5. 请勿将 API 密钥、Globalping Token、心跳设备 Token 或 Webhook 中的敏感信息提交到 GitHub。

详细配置步骤、验证方法和常见问题请参阅[部署指南](docs/CLOUDFLARE_DEPLOYMENT_GUIDE.md)。
