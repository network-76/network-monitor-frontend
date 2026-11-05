# Cloudflare 部署指南（新手版）

本文说明如何把本项目部署到 Cloudflare，包含网页、后台 Worker、D1 数据库、Globalping API、定时任务和后续更新。按顺序操作即可。

> 本项目不是只上传一个 HTML 文件就能运行。它由前端网页、Cloudflare Worker 后端、D1 数据库和 Worker 定时任务组成。
>
> 本指南针对当前代码结构编写。当前后台入口文件为 `work/work_v1.5.js`，前端入口为仓库根目录的 `index.html`。

---

## 一、先了解部署结构

| 组成 | 用途 | 项目中的位置 |
|---|---|---|
| Cloudflare Pages | 托管管理网页 | `index.html` |
| Cloudflare Worker | 提供 API、执行监控调度和告警 | `work/work_v1.5.js` |
| Cloudflare D1 | 保存监控对象、测量结果、心跳设备、Webhook 等数据 | 数据库绑定名为 `DB` |
| Globalping | 提供全球网络探测节点和 Ping 测量能力 | 外部 API |
| Worker Cron Trigger | 定时执行探测、结果轮询和告警处理 | Worker 的定时触发器 |

**重要：** 前端通过相对路径请求 API（例如 `/api/monitors`），所以正式部署时，网页访问域名必须能把这些 `/api/*` 请求转发到本项目的 Worker。不能只部署 Pages 而不配置 API 转发。若当前 Cloudflare 项目已经有可用的 API 转发配置，更新时不要随意改动它。

---

## 二、部署前准备

请先准备：

1. 一个 Cloudflare 账号：<https://dash.cloudflare.com/>
2. 一个 GitHub 账号，并能访问本项目仓库：<https://github.com/network-76/network-monitor-frontend>
3. 一个 Globalping 账号及 API Token：<https://www.globalping.io/>
4. 一个电脑浏览器，建议使用 Chrome 或 Edge。

### 2.1 获取 Globalping Token

1. 打开 Globalping 网站并登录。
2. 进入账户中管理 API Token 的页面。
3. 创建一个 API Token。
4. 复制 Token，暂时保存在安全的地方。

Token 相当于密码，不要发到群聊、不要提交到 GitHub，也不要写进 `index.html`。

### 2.2 准备管理密钥

本项目 Worker 使用环境变量 `MONITOR_API_KEY` 保护管理 API。

建议生成一段足够长的随机字符串（至少 32 字符，建议 64 字符），例如使用密码管理器生成。不要直接使用文档中的示例字符串，也不要把密钥提交到代码仓库。

---

## 三、创建 D1 数据库

D1 用来保存监控系统的数据。

1. 登录 Cloudflare Dashboard。
2. 左侧进入 **Workers & Pages**，再找到 **D1**（部分界面也可通过左侧 Storage & databases 进入）。
3. 点击 **Create database**。
4. 数据库名称建议填写：`network-monitor-db`。
5. 点击创建。
6. 打开刚创建的数据库，记下数据库名称，后面绑定 Worker 时要选择它。

### 3.1 初始化数据库表

数据库必须先创建项目所需的基础表，之后才能执行增量迁移。

在 D1 页面打开 **Console**，按项目提供的 SQL 初始化文件执行建表语句。然后再按编号顺序执行仓库 `migrations/` 目录中的迁移文件。

当前仓库中需要执行的增量迁移包括：

- `migrations/0003_global_time_zone.sql`：创建全局设置表，并初始化默认时区 `Asia/Shanghai`。
- `migrations/0004_soft_delete_monitors.sql`：为监控对象增加软删除字段，删除监控时保留历史数据。

**注意事项：**

- 如果这是全新数据库，不能只执行 0003 和 0004；必须先执行项目基础建表 SQL。缺少基础表时，迁移会报错。
- 如果数据库已经运行过 0003 或 0004，不要重复执行相同迁移。
- 执行 SQL 时，每个文件完整复制到 D1 Console 后执行，并确认页面显示执行成功。
- 不要在生产数据库中随意执行不清楚用途的 `DROP TABLE`、`DELETE` 或 `ALTER TABLE` 语句。

> 如果仓库当前没有提供基础建表 SQL 文件，请先不要猜测表结构或自行创建空表。应从已有正常运行的 D1 数据库导出完整结构，或补齐项目的基础 schema 文件后再进行全新部署。

---

## 四、部署后台 Worker

Worker 负责 API、探测调度、结果轮询、心跳离线判断和 Webhook 通知。

### 4.1 创建 Worker

1. Cloudflare Dashboard → **Workers & Pages**。
2. 点击 **Create application**。
3. 选择 **Create Worker**。
4. Worker 名称建议填写：`network-monitor-api`。
5. 点击部署，先创建一个 Worker。
6. 进入 Worker 的代码编辑页面。

### 4.2 上传项目 Worker 代码

1. 在 GitHub 打开本项目：<https://github.com/network-76/network-monitor-frontend>
2. 进入 `work/work_v1.5.js`。
3. 打开 Raw 或下载文件，取得完整源码。
4. 在 Cloudflare Worker 编辑器中，用完整文件内容替换编辑器里的示例代码。
5. 保存并部署。

不要只复制文件的一部分；必须复制从第一行到最后一行的完整内容。

### 4.3 配置 D1 绑定

1. 打开刚创建的 Worker。
2. 进入 **Settings** → **Bindings**。
3. 点击 **Add**，选择 **D1 database**。
4. Variable name（变量名）填写：`DB`。
5. Database 选择第三步创建的 `network-monitor-db`。
6. 保存绑定。

变量名必须准确写成大写 `DB`，因为 Worker 源码通过 `env.DB` 访问数据库。

### 4.4 配置环境变量和密钥

在 Worker 的 **Settings** → **Variables and Secrets** 中添加：

| 变量名 | 类型 | 值 |
|---|---|---|
| `MONITOR_API_KEY` | Secret | 第二步准备的随机管理密钥 |
| `GLOBALPING_TOKEN` | Secret | 第二步取得的 Globalping API Token |

操作方式：

1. 点击添加变量。
2. 名称按表格填写，注意大小写。
3. 将值粘贴到 Value。
4. 对这两个变量选择 Secret（不要使用普通明文变量）。
5. 保存。

如果 Cloudflare 提示变量更新后需要重新部署，请按页面提示部署新版本。

**不要把这两个值写进 Worker 源码或前端 HTML。**

### 4.5 配置 Worker 定时任务（Cron Trigger）

本项目 Worker 除了接收网页请求，还需要定时运行后台任务。没有 Cron Trigger，自动探测调度、测量结果轮询以及定时告警处理可能不会正常运行。

1. 打开 Worker。
2. 找到 **Settings** → **Triggers**（部分界面会把 Cron 放在 Triggers 页面）。
3. 找到 **Cron Triggers**。
4. 点击添加 Cron。
5. 建议先配置：`* * * * *`（每分钟执行一次）。
6. 保存。

Cron 表达式含义：每分钟触发一次。不要把它设置成每秒执行；Cloudflare Cron 使用五段式表达式。

### 4.6 记录 Worker 地址

部署后 Cloudflare 会提供一个 Worker 域名，通常类似：

`https://network-monitor-api.<你的账户子域>.workers.dev`

请复制并保存这个地址。后续需要将网站的 `/api/*` 请求转发到这个 Worker。

---

## 五、部署前端 Pages

前端是一个静态网页，入口文件是仓库根目录的 `index.html`。

### 5.1 创建 Pages 项目

1. Cloudflare Dashboard → **Workers & Pages**。
2. 点击 **Create application**。
3. 选择 **Pages**，再选择 **Connect to Git**。
4. 授权 Cloudflare 访问 GitHub。
5. 选择仓库：`network-76/network-monitor-frontend)。
6. 选择生产分支：`main`。

### 5.2 配置构建参数

本项目当前是纯静态 HTML 页面，不需要 npm、Node.js 或前端打包。

建议配置：

| 配置项 | 填写值 |
|---|---|
| Framework preset | None（无框架） |
| Build command | 留空 |
| Build output directory | `/` |
| Root directory | `/`（如果页面提供此选项） |

然后点击 **Save and Deploy**。

部署成功后，Cloudflare 会分配一个 Pages 域名，通常类似：

`https://<项目名称>.pages.dev`

打开该地址，应该能看到“网络监控管理系统”页面。

### 5.3 配置 Pages 到 Worker 的 API 转发（非常重要）

当前 `index.html` 使用 `/api/...` 相对路径访问后端。也就是说，用户访问 Pages 域名时，浏览器会向同一个域名请求 API。

因此必须保证：

- `https://<Pages域名>/api/monitors` 等 API 请求实际到达后台 Worker；
- Worker 的 `/api/*` 路由能够被调用；
- 页面请求与 API 处于同源访问路径，避免浏览器跨域问题。

Cloudflare 可以通过 Worker 路由、Pages Functions 或其他同源代理方式实现。具体采用哪一种，取决于当前域名和项目绑定方式。

**不要直接把 Worker 域名填进 HTML，也不要随意添加一个未经验证的路由规则。** 如果当前项目已经能正常通过 Pages 域名调用 API，保留现有转发配置即可。若是全新部署，先在 Cloudflare 中配置好 Pages 域名与 Worker 的同源 API 转发，再进行下一步验证。

---

## 六、首次部署检查

部署完成后，按以下顺序检查。

### 6.1 检查网页

打开 Pages 域名：

- 页面能正常显示；
- 浏览器没有明显的 JavaScript 错误；
- 各个卡片可以正常显示。

### 6.2 检查数据库连接

在浏览器中访问：

`https://<网站域名>/api/db/test`

注意：该接口受 `MONITOR_API_KEY` 管理密钥保护。直接在浏览器地址栏访问通常不会自动携带管理请求头，因此出现 401 不一定代表数据库故障。

更可靠的检查方式是在 Worker 的 Logs 中查看请求错误，或使用能添加 `X-Monitor-Key` 请求头的 API 测试工具进行检查。

成功时接口返回 JSON，包含 `success: true` 和数据库表名列表。

### 6.3 检查监控页面数据

在管理页面检查：

- 监控总览数据是否能加载；
- 监控对象列表是否正常；
- 心跳设备列表是否正常；
- Webhook 配置和告警通知记录是否能加载；
- 时区切换后时间是否立即更新。

如果页面提示 401，优先检查管理 API 鉴权配置及当前站点到 Worker 的请求转发，不要把管理密钥写进前端页面。

### 6.4 检查 Globalping 探测

在页面中创建一个测试监控对象，填写目标 IP 或域名，配置探测地区代码，然后观察测量是否能正常完成。

如果出现 `GLOBALPING_TOKEN missing`，说明 Worker 没有正确配置 `GLOBALPING_TOKEN` Secret。

如果 Globalping 返回鉴权错误，检查 Token 是否复制完整、是否仍有效。

### 6.5 检查心跳设备

1. 在心跳设备卡片中添加一个测试设备。
2. 复制系统生成的心跳 URL。
3. 在能访问公网的 Linux 设备上执行：

```bash
curl -i "将这里替换为系统生成的完整心跳URL"
```

心跳协议是 GET 请求，不需要额外 Header，也不需要 Body。

注意：心跳 URL 中包含设备 Token，应按密码管理，不能公开分享。测试成功后，页面中应能看到最近心跳时间和在线状态。

### 6.6 检查 Cron

1. 打开 Worker 的 Logs。
2. 等待至少一到两个 Cron 周期。
3. 检查是否出现 Cron 执行记录。
4. 如果没有执行记录，检查 Cron Trigger 是否保存到了当前正在使用的 Worker 环境。

---

## 七、后续如何更新系统

日常开发更新通常只需要更新 GitHub 仓库文件。

### 7.1 只修改了前端

例如只修改 `index.html`：

1. 将新代码提交到 GitHub 的 `main` 分支。
2. Cloudflare Pages 会自动开始部署。
3. 等待部署状态变为 Success。
4. 浏览器强制刷新页面（Windows：Ctrl + F5）。

不需要重新部署 Worker，也不需要执行数据库迁移。

### 7.2 修改了 Worker

例如修改 `work/work_v1.5.js`：

1. 在 GitHub 提交最新 Worker 代码。
2. 打开 Cloudflare Worker 编辑页面。
3. 将完整最新源码复制到 Worker 编辑器。
4. 保存并部署。
5. 检查 Worker Logs 是否有运行错误。

如果项目后续改为 Git 集成自动部署 Worker，则按对应自动部署流程操作；在没有确认自动部署已配置前，不要假设 GitHub 提交会自动更新 Worker。

### 7.3 增加了数据库迁移文件

如果代码更新同时新增了 `migrations/xxxx_xxxx.sql`：

1. 先备份 D1 数据库。
2. 打开 D1 → 对应数据库 → Console。
3. 查看本次新增的迁移 SQL。
4. 确认之前没有执行过该迁移。
5. 完整执行新增 SQL，并确认成功。
6. 再部署依赖该字段或数据结构的 Worker 代码。

**数据库迁移通常只执行一次。** 不要因为重复部署代码就重复执行迁移。

### 7.4 更新顺序速查

| 变更内容 | 需要做什么 |
|---|---|
| 只改 `index.html` | 等待 Pages 自动部署 |
| 只改 Worker JS | 更新并部署 Worker |
| 新增 D1 migration | 先备份，再执行新增 SQL |
| 同时改 Worker 和 D1 | 先执行兼容的数据库迁移，再部署 Worker |
| 同时改前端和 Worker | 分别部署 Pages 和 Worker |

---

## 八、备份与安全建议

### 8.1 定期备份 D1

D1 保存监控对象、测量历史、心跳设备和告警记录。建议定期通过 Cloudflare D1 的导出/备份功能保存数据库副本。

执行数据库结构调整前，先做一次备份。

### 8.2 保护密钥

以下内容属于敏感信息：

- `MONITOR_API_KEY`
- `GLOBALPING_TOKEN`
- 心跳设备 URL 中的 Token
- Webhook URL（可能包含密钥）

不要把这些内容提交到 GitHub、截图公开或发给无关人员。

### 8.3 限制管理页面访问

管理 API 使用 `MONITOR_API_KEY` 校验请求。建议同时使用 Cloudflare Access 等访问控制保护管理页面，避免管理界面直接暴露给所有互联网用户。

---

## 九、常见问题

### 1. 页面能打开，但监控列表一直加载失败

优先检查：

- Pages 域名的 `/api/*` 是否正确转发到 Worker；
- Worker 是否部署成功；
- Worker 是否绑定了 D1，绑定变量名是否为 `DB`；
- `MONITOR_API_KEY` 是否配置正确；
- Worker Logs 是否有数据库或鉴权错误。

### 2. 提示 `Unauthorized` 或 HTTP 401

表示 Worker 没有通过管理密钥校验。检查管理请求是否正确携带 `X-Monitor-Key`，以及当前部署是否配置了 `MONITOR_API_KEY`。

不要为了绕过 401 而删除 Worker 的鉴权代码。

### 3. 提示 `DB binding missing` 或数据库相关错误

检查 Worker 的 D1 Binding：

- Variable name 必须是 `DB`；
- 绑定的数据库必须是本项目实际使用的 D1；
- 基础表和所需迁移必须已经执行。

### 4. 提示 `GLOBALPING_TOKEN missing`

在 Worker 的 Variables and Secrets 中添加或检查 `GLOBALPING_TOKEN`，保存后重新部署。

### 5. 页面修改后没有变化

- Pages 部署是否成功；
- 是否部署到了 `main` 分支；
- 浏览器是否仍使用旧缓存；
- 使用 Ctrl + F5 强制刷新。

### 6. 心跳设备一直显示离线

检查设备端是否定时请求系统生成的完整心跳 URL。请求方式必须为 GET，且设备必须能访问该 URL。再查看 Worker Logs 和心跳设备最后心跳时间。

### 7. 告警没有发送

检查：

- 是否创建并启用了 Webhook 配置；
- Webhook 是否订阅了对应 DOWN / UP 事件；
- Webhook URL 是否有效；
- Worker Cron Trigger 是否正常执行；
- Worker Logs 中是否有发送失败或重试记录。

---

## 十、部署完成检查清单

完成后逐项确认：

- [ ] D1 数据库已创建
- [ ] 基础数据库表已初始化
- [ ] 需要的 migration 已按顺序执行
- [ ] Worker 已部署
- [ ] Worker 已绑定 D1，变量名为 `DB`
- [ ] 已配置 Secret：`MONITOR_API_KEY`
- [ ] 已配置 Secret：`GLOBALPING_TOKEN`
- [ ] Cron Trigger 已配置并能正常执行
- [ ] Pages 已连接 GitHub 仓库并部署成功
- [ ] Pages 域名的 `/api/*` 已正确转发到 Worker
- [ ] 管理页面能正常读取数据
- [ ] Globalping 测试探测成功
- [ ] 心跳设备测试成功
- [ ] Webhook 测试发送成功

完成以上检查后，系统才算部署完成。
